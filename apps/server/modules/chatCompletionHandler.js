// modules/chatCompletionHandler.js
const messageProcessor = require('./messageProcessor.js');
const vcpInfoHandler = require('../vcpInfoHandler.js');
const contextManager = require('./contextManager.js');
const roleDivider = require('./roleDivider.js');
const { projectToolBatchForUpstream } = require('./toolResultBatch.js');
const nativeContext = require('./requestExecutionContext');
const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const https = require('https');
const finalContextStore = require('./finalContextStore.js');

// 多模态配置真相源（JSON 优先 + 热更新），用于在请求时动态拉取 MultiModalForceTranslateModels
let multiModalConfigStore = null;
try {
  multiModalConfigStore = require('./multiModalConfigStore.js');
} catch (storeError) {
  multiModalConfigStore = null;
}

// 🌟 核心网络优化：引入防御性长连接池 (Keep-Alive Pool)
// 解决 "-1s Socket Hang Up" 与上游代理秒断僵尸连接的问题
const agentOptions = {
  keepAlive: true,
  keepAliveMsecs: 1000,     // 维持 Node.js 默认的 1s TCP 探针间隔
  freeSocketTimeout: 8000,  // 绝杀机制：空闲 Socket 8 秒后主动销毁，防止复用到被上游代理 (如 Nginx) 静默杀死的僵尸连接
  scheduling: 'lifo',       // 后进先出：永远优先复用刚刚才活跃过、最新鲜的热连接
  maxSockets: 10000         // 维持全局高并发上限
};
const keepAliveHttpAgent = new http.Agent(agentOptions);
const keepAliveHttpsAgent = new https.Agent(agentOptions);

const getFetchAgent = function(_parsedURL) {
  return _parsedURL.protocol === 'http:' ? keepAliveHttpAgent : keepAliveHttpsAgent;
};

const { getAuthCode } = require('./captchaDecoder');
const ToolCallParser = require('./vcpLoop/toolCallParser');
const ToolExecutor = require('./vcpLoop/toolExecutor');
const StreamHandler = require('./handlers/streamHandler');
const NonStreamHandler = require('./handlers/nonStreamHandler');
const HttpTurnSink = require('./handlers/httpTurnSink');

const VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER = '[[VCPToolUse=Forbidden]]';
const residentPresence = require('./vcpLoop/residentPresence');

function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function normalizeClientIp(ip) {
  if (ip && ip.substr(0, 7) === '::ffff:') {
    return ip.substr(7);
  }
  return ip || 'unknown';
}

class ResponseReplayCache {
  constructor({ enabled = false, maxEntries = 100, debugMode = false } = {}) {
    this.enabled = enabled;
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 100;
    this.debugMode = debugMode;
    this.cache = new Map();
  }

  buildKey(clientIp, messageId) {
    if (!this.enabled || !messageId) return null;
    return `${normalizeClientIp(clientIp)}::${String(messageId)}`;
  }

  get(key) {
    if (!this.enabled || !key || !this.cache.has(key)) return null;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, entry) {
    if (!this.enabled || !key || !entry || !Array.isArray(entry.chunks) || entry.chunks.length === 0) return;
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, {
      ...entry,
      chunks: entry.chunks.map(chunk => Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk))),
      cachedAt: Date.now()
    });

    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    if (this.debugMode) {
      console.log(`[ResponseReplayCache] Cached response for key=${key}. entries=${this.cache.size}/${this.maxEntries}`);
    }
  }

  replay(key, req, res) {
    const entry = this.get(key);
    if (!entry) return false;

    if (this.debugMode) {
      console.log(`[ResponseReplayCache] Replaying cached response for key=${key}. No tool chain will be executed.`);
    }

    if (!res.headersSent) {
      res.status(entry.statusCode || 200);
      for (const [name, value] of Object.entries(entry.headers || {})) {
        if (value !== undefined && value !== null) {
          res.setHeader(name, value);
        }
      }
    }

    for (const chunk of entry.chunks) {
      if (res.writableEnded || res.destroyed) break;
      res.write(chunk);
    }

    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }

    return true;
  }
}

function installResponseCacheRecorder(res, { cache, cacheKey, id, clientIp, streamMode, debugMode }) {
  if (!cache?.enabled || !cacheKey || res.__vcpReplayCacheRecorderInstalled) {
    return () => {};
  }

  res.__vcpReplayCacheRecorderInstalled = true;

  const capturedChunks = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let finalized = false;
  let cacheDisabled = false;

  Object.defineProperty(res, '__vcpDisableReplayCache', {
    configurable: true,
    enumerable: false,
    value() {
      cacheDisabled = true;
      capturedChunks.length = 0;
    },
    writable: false
  });

  const captureChunk = (chunk, encoding) => {
    if (chunk === undefined || chunk === null) return;
    if (Buffer.isBuffer(chunk)) {
      capturedChunks.push(Buffer.from(chunk));
    } else {
      capturedChunks.push(Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
    }
  };

  res.write = function patchedWrite(chunk, encoding, callback) {
    captureChunk(chunk, encoding);
    return originalWrite(chunk, encoding, callback);
  };

  res.end = function patchedEnd(chunk, encoding, callback) {
    captureChunk(chunk, encoding);
    return originalEnd(chunk, encoding, callback);
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;

    const statusCode = res.statusCode || 200;
    if (!cacheDisabled
      && statusCode >= 200
      && statusCode < 500
      && capturedChunks.length > 0) {
      cache.set(cacheKey, {
        id,
        clientIp,
        streamMode,
        statusCode,
        headers: res.getHeaders ? res.getHeaders() : {},
        chunks: capturedChunks
      });
    } else if (debugMode && !cacheDisabled) {
      console.log(`[ResponseReplayCache] Skip caching key=${cacheKey}, status=${statusCode}, chunks=${capturedChunks.length}`);
    }
    try {
      delete res.__vcpDisableReplayCache;
    } catch {
      // Response disposal remains the final cleanup boundary.
    }
  };

  res.once('finish', finalize);

  return finalize;
}

/**
 * 从顶层 system 提示词中检测并移除 VCP 工具禁用占位符。
 * 只扫描首个连续 system 消息区间，避免普通上下文/用户内容误触发。
 * @param {Array} messages
 * @returns {boolean}
 */
function consumeVcpToolUseForbiddenPlaceholder(messages) {
  if (!Array.isArray(messages)) return false;

  let found = false;
  for (const msg of messages) {
    if (!msg || msg.role !== 'system') break;

    if (typeof msg.content === 'string') {
      if (msg.content.includes(VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER)) {
        found = true;
        msg.content = msg.content.split(VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER).join('');
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.includes(VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER)) {
          found = true;
          part.text = part.text.split(VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER).join('');
        }
      }
    }
  }

  return found;
}

/**
 * 检测当前真实后端模型是否命中纯文本模型 Tag 列表（不区分大小写）。
 * 配合模型动态路由（VCPModelAuto / SemanticModelRouter）使用：
 * 当语义路由切换到不支持多模态的模型（如 deepseek-v4 / GLM-4.5）时，
 * 自动把 base64 翻译为文本，避免上游 API 报错或丢图。
 *
 * @param {string} modelName 真实后端模型名（已经过 ModelRedirect 与语义路由解析）
 * @param {string[]} tagList tag 数组（已统一为小写，由 server.js 解析）
 * @returns {boolean} 是否命中
 */
function isTextOnlyModelByTag(modelName, tagList) {
  if (!modelName || !Array.isArray(tagList) || tagList.length === 0) return false;
  const lowerName = String(modelName).toLowerCase();
  for (const tag of tagList) {
    if (!tag) continue;
    if (lowerName.includes(tag)) return true;
  }
  return false;
}

/**
 * 检测一条消息（或其 content 数组）中是否包含 base64 多模态部分。
 * 仅用于 Force-Translate 触发判定，避免在没有图片/音视频的请求里空转翻译插件。
 *
 * @param {Array} messages 消息数组
 * @returns {boolean}
 */
function messagesContainBase64Media(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'system')) continue;
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        part &&
        part.type === 'image_url' &&
        part.image_url &&
        typeof part.image_url.url === 'string' &&
        /^data:(image|audio|video)\/[^;]+;base64,/.test(part.image_url.url)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Copy non-enumerable array metadata produced by upstream preprocessors.
 * OneRing attaches __oneRingMeta to the messages array itself; any pipeline
 * step that returns a fresh array must preserve it explicitly.
 */
function copyArrayMetadata(source, target) {
  if (!Array.isArray(source) || !Array.isArray(target)) return target;

  for (const key of Object.getOwnPropertyNames(source)) {
    if (/^(?:length|\d+)$/.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    try { Object.defineProperty(target, key, descriptor); }
    catch {
      // Legacy metadata remains best-effort.
    }
  }

  residentPresence.verifyMetadataCopy(source, target);
  return target;
}

/**
 * 检测工具返回结果是否为错误
 * @param {any} result - 工具返回的结果
 * @returns {boolean} - 是否为错误结果
 */
function isToolResultError(result) {
  if (result === undefined || result === null) {
    return false; // 空结果不视为错误
  }

  // 1. 对象形式的错误检测
  if (typeof result === 'object') {
    // 判定顺序必须先看明确成功标志：
    // 工具成功返回的正文/嵌套字段里可能包含“拒绝/错误/error”等业务文本，不能因此覆盖 status: success。
    if (
      result.success === true ||
      result.status === 'success' ||
      result.status === 'ok' ||
      result.ok === true
    ) {
      return false;
    }

    // 然后只信任结构化失败字段。
    if (
      result.error === true ||
      result.success === false ||
      result.status === 'error' ||
      result.status === 'failed' ||
      result.status === 'failure' ||
      result.ok === false
    ) {
      return true;
    }

    const codeValue = result.code ?? result.statusCode ?? result.httpStatus;
    const numericCode = Number(codeValue);
    if (Number.isFinite(numericCode) && numericCode >= 400 && numericCode < 600) {
      return true;
    }

    return false;
  }

  // 2. 字符串形式的错误检测（模糊匹配）
  if (typeof result === 'string') {
    const lowerResult = result.toLowerCase();

    // 检查是否以错误前缀开头（更可靠的判断）
    const errorPrefixes = [
      '[error]', '[错误]', '[失败]', 'error:', '错误：', '失败：'
    ];
    for (const prefix of errorPrefixes) {
      if (lowerResult.startsWith(prefix)) {
        return true;
      }
    }

    // 字符串仅接受显式错误前缀/格式，不再因正文任意位置包含“错误/失败/拒绝”等业务文本而误判。
    if (lowerResult.includes('error:') || lowerResult.includes('failed:')) {
      return true;
    }
  }

  return false;
}

/**
 * 格式化工具结果为字符串
 * @param {any} result - 工具返回的结果
 * @returns {string} - 格式化后的字符串
 */
function formatToolResult(result) {
  if (result === undefined || result === null) {
    return '(无返回内容)';
  }
  if (typeof result === 'object') {
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

async function getRealAuthCode(debugMode = false) {
  try {
    const authCodePath = path.join(__dirname, '..', 'Plugin', 'UserAuth', 'code.bin');
    // 使用正确的 getAuthCode 函数，它会自行处理文件读取和解码
    return await getAuthCode(authCodePath);
  } catch (error) {
    if (debugMode) {
      console.error('[VCPToolCode] Failed to read or decrypt auth code:', error);
    }
    return null; // Return null if code cannot be obtained
  }
}

function applyModelFallbackForAttempt(options, candidates, attemptIndex, debugMode = false) {
  if (!Array.isArray(candidates) || candidates.length === 0 || !options || typeof options.body !== 'string') {
    return options;
  }

  const selectedModel = candidates[Math.min(attemptIndex, candidates.length - 1)];
  if (!selectedModel) return options;

  try {
    const parsedBody = JSON.parse(options.body);
    if (!parsedBody || typeof parsedBody !== 'object') return options;

    const previousModel = parsedBody.model;
    parsedBody.model = selectedModel;

    if (debugMode && previousModel !== selectedModel) {
      console.log(`[SemanticModelRouter] 容灾切换上游模型: ${previousModel} -> ${selectedModel} (attempt=${attemptIndex + 1})`);
    }

    return {
      ...options,
      body: JSON.stringify(parsedBody)
    };
  } catch (error) {
    if (debugMode) {
      console.warn(`[SemanticModelRouter] 无法为本次重试替换模型，继续使用原始请求体: ${error.message}`);
    }
    return options;
  }
}

// A helper function to handle fetch with retries for specific status codes
// connectionTimeout: 连接超时安全网，防止上游 API 静默挂起导致永久等待（仅覆盖到收到响应头为止）
async function fetchWithRetry(
  url,
  options,
  {
    retries = 3,
    delay = 1000,
    debugMode = false,
    onRetry = null,
    connectionTimeout = 900000,
    modelFallbackCandidates = null,
    beforeProviderAttempt = null
  } = {},
) {
  const { default: fetch } = await import('node-fetch');
  const maxAttempts = Math.max(
    Number.isFinite(Number(retries)) && Number(retries) > 0 ? Math.floor(Number(retries)) : 1,
    Array.isArray(modelFallbackCandidates) ? modelFallbackCandidates.length : 0
  );
  for (let i = 0; i < maxAttempts; i++) {
    // 为每次尝试创建独立的中止控制器，用于超时保护
    const attemptController = new AbortController();
    let didTimeout = false;
    const externalSignal = options.signal;

    // 将外部中止信号转发给本次尝试的控制器
    let removeExternalListener = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      }
      const forwardAbort = () => attemptController.abort();
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
      removeExternalListener = () => externalSignal.removeEventListener('abort', forwardAbort);
    }

    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (removeExternalListener) removeExternalListener();
    };

    const attemptOptions = applyModelFallbackForAttempt(
      options,
      modelFallbackCandidates,
      i,
      debugMode
    );
    if (beforeProviderAttempt) {
      try {
        await beforeProviderAttempt(url, attemptOptions, { controller: attemptController, connectionTimeout });
      } catch (error) {
        cleanup();
        throw error;
      }
    }
    // Every model turn, including a tool follow-up, uses the original Work fence.
    try { nativeContext.assertDispatch(); }
    catch (error) { cleanup(); throw error; }
    if (attemptController.signal.aborted) {
      cleanup();
      throw Object.assign(new Error('The operation was aborted.'), {
        name: 'AbortError'
      });
    }

    // Provider connection timeout starts only after the local authority seal.
    timeoutId = connectionTimeout > 0
      ? setTimeout(() => { didTimeout = true; attemptController.abort(); }, connectionTimeout)
      : null;

    try {
      const response = await fetch(url, {
        ...attemptOptions,
        agent: getFetchAgent, // 注入防御性长连接池
        signal: externalSignal ? AbortSignal.any([attemptController.signal, externalSignal]) : attemptController.signal,
      });
      cleanup();

      let shouldRetryStatus = response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504 || response.status === 429;
      let retryMessage = response.statusText;

      // Gemini / NewAPI 偶发特殊空回：上游可能以 401 返回包含 token 的错误文本
      // 例如：{"error":{"message":"Invalid token ..."}}
      // 这类并非 VCP 本地 Key 配置错误，而是上游瞬时 token 异常，可安全纳入重试。
      if (response.status === 401) {
        try {
          const responseBodyText = await response.clone().text();
          if (responseBodyText.toLowerCase().includes('token')) {
            shouldRetryStatus = true;
            retryMessage = responseBodyText || response.statusText;
          }
        } catch (bodyReadError) {
          if (debugMode) {
            console.warn(`[Fetch Retry] Failed to inspect 401 response body: ${bodyReadError.message}`);
          }
        }
      }

      if (shouldRetryStatus) {
        if (i === maxAttempts - 1) {
          if (debugMode) {
            console.warn(`[Fetch Retry] Received status ${response.status}. All retries exhausted (${i + 1}/${maxAttempts}). Returning last response.`);
          }
          return response;
        }
        const currentDelay = delay * (i + 1);
        if (debugMode) {
          console.warn(
            `[Fetch Retry] Received status ${response.status}. Retrying in ${currentDelay}ms... (${i + 1}/${maxAttempts})`,
          );
        }
        if (onRetry) {
          await onRetry(i + 1, { status: response.status, message: retryMessage });
        }
        await new Promise(resolve => setTimeout(resolve, currentDelay));
        continue;
      }
      return response;
    } catch (error) {
      cleanup();
      if (nativeContext.isCoreTurn() && !externalSignal?.aborted) {
        throw Object.assign(new Error('CORE_PROVIDER_OUTCOME_UNKNOWN', { cause: error }), { code: 'CORE_PROVIDER_OUTCOME_UNKNOWN' });
      }

      // 区分超时中止和外部中止
      if (error.name === 'AbortError') {
        if (didTimeout) {
          // 超时中止 → 视为可重试的网络错误
          const msg = `Connection timed out after ${connectionTimeout / 1000}s`;
          if (i === maxAttempts - 1) {
            console.error(`[Fetch Retry] ${msg}. All retries exhausted.`);
            throw new Error(msg);
          }
          if (debugMode) console.warn(`[Fetch Retry] ${msg}. Retrying... (${i + 1}/${retries})`);
          if (onRetry) {
            await onRetry(i + 1, { status: 'TIMEOUT', message: msg });
          }
          await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
          continue;
        }
        // 外部中止（用户取消）→ 不重试
        if (debugMode) console.log('[Fetch Retry] Request was aborted. No retries will be attempted.');
        throw error;
      }

      if (i === maxAttempts - 1) {
        console.error(`[Fetch Retry] All retries failed. Last error: ${error.message}`);
        throw error;
      }
      if (debugMode) {
        console.warn(
          `[Fetch Retry] Fetch failed with error: ${error.message}. Retrying in ${delay}ms... (${i + 1}/${retries})`,
        );
      }
      if (onRetry) {
        await onRetry(i + 1, { status: 'NETWORK_ERROR', message: error.message });
      }
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }
  throw new Error('Fetch failed after all retries.');
}

// 剥离 Markdown 代码块，避免 VCP Refresh 误扫源码示例中的伪 RAG 标签
function stripMarkdownCodeFencesForRagRefresh(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/```[\s\S]*?```/g, '');
}

// 安全解析 RAG metadata：必须是合法 JSON 对象，否则跳过（不抛错污染用户请求）
function safeParseRagBlockMetadata(rawMetadata, debugMode = false) {
  if (typeof rawMetadata !== 'string') return null;
  const trimmed = rawMetadata.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    if (debugMode) console.warn(`[VCP Refresh] 跳过非 JSON metadata: ${trimmed.slice(0, 80)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (e) {
    if (debugMode) console.warn(`[VCP Refresh] metadata JSON 解析失败，跳过: ${e.message}`);
    return null;
  }
}

// 辅助函数：根据新上下文刷新对话历史中由真实 system 消息承载的 RAG 区块
async function _refreshRagBlocksIfNeeded(messages, newContext, pluginManager, debugMode = false) {
  const ragPlugin = pluginManager.messagePreprocessors?.get('RAGDiaryPlugin');
  // 检查插件是否存在且是否实现了refreshRagBlock方法
  if (!ragPlugin || typeof ragPlugin.refreshRagBlock !== 'function') {
    if (debugMode) {
      console.log('[VCP Refresh] RAGDiaryPlugin 未找到或版本不兼容 (缺少 refreshRagBlock)，跳过刷新。');
    }
    return messages;
  }

  // 创建消息数组的深拷贝以安全地进行修改
  const newMessages = JSON.parse(JSON.stringify(messages));
  let hasRefreshed = false;

  // metadata 只接受 JSON 对象，避免误匹配源码示例、正则模板和未渲染占位符。
  const ragBlockRegex = /<!-- VCP_RAG_BLOCK_START\s+(\{[\s\S]*?\})\s+-->([\s\S]*?)<!-- VCP_RAG_BLOCK_END -->/g;

  for (let i = 0; i < newMessages.length; i++) {
    // 安全边界：只刷新协议层真实的 system 消息。
    // 不接受 assistant、普通 user 或通过文本前缀模拟的“虚拟 system-user”，
    // 否则客户端可自行构造合法 RAG metadata，在工具循环中触发任意日记本刷新。
    if (newMessages[i]?.role === 'system' && typeof newMessages[i].content === 'string') {
      // 先剥离 Markdown 代码围栏，避免扫描到示例中的伪 RAG 标签。
      let messageContent = stripMarkdownCodeFencesForRagRefresh(newMessages[i].content);

      // 快速检查是否存在标记，避免无效正则匹配
      if (!messageContent.includes('VCP_RAG_BLOCK_START')) {
        continue;
      }

      // 使用 replace 的回调函数模式来处理异步逻辑通常比较麻烦
      // 所以我们先收集所有匹配项，然后串行处理替换
      const matches = [...messageContent.matchAll(ragBlockRegex)];

      if (matches.length > 0) {
        if (debugMode) console.log(`[VCP Refresh] 消息[${i}]中发现 ${matches.length} 个 RAG 区块，准备刷新...`);

        // 我们从后往前替换，这样替换操作不会影响前面匹配项的索引位置（虽然 replace(str) 不依赖索引，但这是一个好习惯）
        // 这里为了简单，我们直接构建一个新的 content 字符串或使用 split/join 策略

        for (const match of matches) {
          const fullMatchString = match[0]; // 完整的 ... const metadataJson = match[1];    // 第一个捕获组：元数据 JSON
          const metadataJson = match[1];

          try {
            const metadata = safeParseRagBlockMetadata(metadataJson, debugMode);
            if (!metadata) {
              continue;
            }

            if (debugMode) {
              console.log(`[VCP Refresh] 正在刷新区块 (${metadata.dbName})...`);
            }

            // V4.0: Find the last *true* user message to use as the original query
            let originalUserQuery = '';
            // Search backwards from the message *before* the one containing the RAG block
            for (let j = i - 1; j >= 0; j--) {
              const prevMsg = newMessages[j];
              if (prevMsg.role === 'user' && typeof prevMsg.content === 'string' &&
                !prevMsg.content.startsWith('<!-- VCP_TOOL_PAYLOAD -->') &&
                !prevMsg.content.startsWith('[系统提示:]') &&
                !prevMsg.content.startsWith('[系统邀请指令:]')
              ) {
                originalUserQuery = prevMsg.content;
                if (debugMode) console.log(`[VCP Refresh] Found original user query for refresh at index ${j}.`);
                break; // Found it, stop searching
              }
            }
            if (!originalUserQuery && debugMode) {
              console.warn(`[VCP Refresh] Could not find a true user query for the RAG block at index ${i}. Refresh may be inaccurate.`);
            }

            // 调用 RAG 插件的刷新接口, now with originalUserQuery
            const newBlock = await ragPlugin.refreshRagBlock(metadata, newContext, originalUserQuery);

            // 🟢 改进点4：关键修复！使用回调函数进行替换，防止 newBlock 中的 "$" 符号被解析为正则特殊字符
            // 这是一个极其常见的 Bug，导致包含 $ 的内容（如公式、代码）替换失败或乱码
            messageContent = messageContent.replace(fullMatchString, () => newBlock);

            hasRefreshed = true;

          } catch (e) {
            console.error("[VCP Refresh] 刷新 RAG 区块失败:", e.message);
            if (debugMode) console.error(e);
            // 出错时保持原样，不中断流程
          }
        }
        newMessages[i].content = messageContent;
      }
    }
  }

  if (hasRefreshed && debugMode) {
    console.log("[VCP Refresh] ✅ 对话历史中的 RAG 记忆区块已根据新上下文成功刷新。");
  }

  return newMessages;
}

class ChatCompletionHandler {
  constructor(config) {
    this.config = config;
    this.responseReplayCache = new ResponseReplayCache({
      enabled: parseBooleanEnv(config.responseReplayCacheEnabled ?? process.env.ResponseReplayCacheEnabled, false),
      maxEntries: parseInt(config.responseReplayCacheMaxEntries ?? process.env.ResponseReplayCacheMaxEntries, 10) || 100,
      debugMode: config.DEBUG_MODE
    });
    this.toolExecutor = new ToolExecutor({
      pluginManager: config.pluginManager,
      webSocketServer: config.webSocketServer,
      debugMode: config.DEBUG_MODE,
      vcpToolCode: config.VCPToolCode,
      getRealAuthCode: getRealAuthCode
    });
  }

  async handle(req, res, forceShowVCP = false) {
    const { activeRequests, DEBUG_MODE } = this.config;
    const id = req.body.requestId || req.body.messageId;
    const clientIp = normalizeClientIp(req.ip);
    const resident = residentPresence.hasIntent(req.body);
    const responseCacheKey = resident ? null : this.responseReplayCache.buildKey(clientIp, id);
    nativeContext.requireModelOutcome(res);
    if (responseCacheKey && this.responseReplayCache.replay(responseCacheKey, req, res)) return;
    const finalizeCache = responseCacheKey ? installResponseCacheRecorder(res, {
      cache: this.responseReplayCache, cacheKey: responseCacheKey, id, clientIp,
      streamMode: req.body.stream === true, debugMode: DEBUG_MODE
    }) : () => {};
    const abortController = new AbortController();
    const requestData = { req, res, abortController, timestamp: Date.now(), aborted: false, abortReason: null };
    const abort = reason => {
      if (res.writableEnded || requestData.aborted) return;
      requestData.aborted = true;
      requestData.abortReason = reason;
      abortController.abort();
    };
    const onAborted = () => abort('request_aborted');
    const onRequestClose = () => { if (req.aborted) abort('request_close_after_abort'); };
    const onResponseClose = () => abort('response_close_before_finish');
    if (id) activeRequests.set(id, requestData);
    req.on('aborted', onAborted);
    req.on('close', onRequestClose);
    res.on('close', onResponseClose);
    let outcome;
    try {
      outcome = await nativeContext.withTurnSignal(abortController.signal, signal => this.executeTurn({
        body: req.body, clientIp, userAgent: req.headers['user-agent'],
        acceptHeader: req.headers.accept, forceShowVCP, signal
      }, new HttpTurnSink(req, res)));
      return outcome;
    } finally {
      nativeContext.recordModelOutcome(res, outcome?.completed === true);
      req.off('aborted', onAborted);
      req.off('close', onRequestClose);
      res.off('close', onResponseClose);
      if (res.destroyed && !res.writableEnded) abort('response_destroyed_in_finally');
      if (res.destroyed || res.writableEnded) finalizeCache();
      if (id) setImmediate(() => { if (activeRequests.get(id) === requestData) activeRequests.delete(id); });
    }
  }

  async executeTurn({ body, clientIp, userAgent, acceptHeader, forceShowVCP = false, signal }, sink) {
    const {
      apiUrl,
      apiKey,
      modelRedirectHandler,
      pluginManager,
      writeDebugLog,
      writeChatLog,
      webSocketServer,
      DEBUG_MODE,
      SHOW_VCP_OUTPUT,
      VCPToolCode,
      maxVCPLoopStream,
      maxVCPLoopNonStream,
      apiRetries,
      apiRetryDelay,
      RAGMemoRefresh,
      apiConnectionTimeoutMs,
      enableRoleDivider, // 新增
      enableRoleDividerInLoop, // 新增
      roleDividerIgnoreList, // 新增
      roleDividerSwitches, // 新增
      roleDividerScanSwitches, // 新增
      roleDividerRemoveDisabledTags, // 新增
      chinaModel1, // 新增
      chinaModel1Cot, // 新增
      semanticModelRouter,
      multiModalForceTranslateModels: configForceTranslateModels, // 启动时快照（ENV）作为兜底
    } = this.config;

    // 优先从 multimodal-config.json 真相源拉取最新 tag 列表，失败时回退 ENV 快照
    let multiModalForceTranslateModels = configForceTranslateModels;
    if (multiModalConfigStore) {
      try {
        const liveTags = multiModalConfigStore.getForceTranslateModels();
        if (Array.isArray(liveTags)) {
          multiModalForceTranslateModels = liveTags;
        }
      } catch (storeReadErr) {
        // 静默回退，不阻塞请求
      }
    }

    const shouldShowVCP = SHOW_VCP_OUTPUT || forceShowVCP;
    const applyChinaModelThinkingControl = (body) => {
      if (!body || !body.model || !chinaModel1 || !Array.isArray(chinaModel1) || chinaModel1.length === 0) {
        return body;
      }

      const modelNameLower = String(body.model).toLowerCase();
      const isChinaModel = chinaModel1.some(m => modelNameLower.includes(String(m).toLowerCase()));
      if (!isChinaModel) return body;

      if (chinaModel1Cot) {
        body.thinking = { type: "enabled" };
      } else {
        delete body.thinking;
      }

      if (DEBUG_MODE) {
        console.log(`[ChinaModel] 模型 '${body.model}' 匹配成功。思维链状态: ${chinaModel1Cot ? '开启 (enabled)' : '关闭 (已移除字段)'}`);
      }

      return body;
    };

    const id = body.requestId || body.messageId;
    let originalBody = nativeContext.prepareContinuationBody(body);
    const presence = residentPresence.takeIntent(originalBody);
    const vcpchatExtensions = originalBody && typeof originalBody === 'object'
      ? originalBody.vcpchatExtensions
      : null;
    if (vcpchatExtensions !== undefined) {
      delete originalBody.vcpchatExtensions;
      const bindingCount = Array.isArray(vcpchatExtensions?.messageTimestampBindings)
        ? vcpchatExtensions.messageTimestampBindings.length
        : 0;
      console.log(`[VCPChatExtensions] Intercepted and stripped vcpchatExtensions before upstream forwarding. timestampBindings=${bindingCount}`);
    }
    const requestPreprocessorConfig = vcpchatExtensions
      ? { vcpchatExtensions }
      : {};
    // 请求独享，PluginManager 浅拷贝配置时仍保留此对象引用。
    requestPreprocessorConfig.tavernInteraction = {};
    const isOriginalRequestStreaming = originalBody.stream === true;
    const abortController = { signal };
    let interactionCompletion;
    let interactionOutcomeAccepted = false;

    // --- 上下文控制 (Context Control) ---
    // 1. 拦截 contextTokenLimit 参数
    const contextTokenLimit = originalBody.contextTokenLimit;
    if (contextTokenLimit !== undefined) {
      if (DEBUG_MODE) console.log(`[ContextControl] 检测到 contextTokenLimit: ${contextTokenLimit}`);
      // 2. 从发送给后端的 body 中移除该参数
      delete originalBody.contextTokenLimit;

      // 3. 执行上下文修剪
      if (originalBody.messages && Array.isArray(originalBody.messages)) {
        const originalCount = originalBody.messages.length;
        originalBody.messages = await contextManager.pruneMessagesSmart(
          originalBody.messages,
          contextTokenLimit,
          DEBUG_MODE
        );
        if (DEBUG_MODE && originalBody.messages.length < originalCount) {
          console.log(`[ContextControl] 上下文已修剪: ${originalCount} -> ${originalBody.messages.length} 条消息`);
        }
      }
    }

    try {
      presence?.validate();
      if (originalBody.model) {
        const originalModel = originalBody.model;
        const isSemanticRoutingModel = semanticModelRouter && typeof semanticModelRouter.isRoutingModel === 'function'
          ? semanticModelRouter.isRoutingModel(originalModel)
          : false;

        if (!isSemanticRoutingModel) {
          const redirectedModel = modelRedirectHandler.redirectModelForBackend(originalModel);
          if (redirectedModel !== originalModel) {
            originalBody = { ...originalBody, model: redirectedModel };
            console.log(`[ModelRedirect] 客户端请求模型 '${originalModel}' 已重定向为后端模型 '${redirectedModel}'`);
          }

          // --- 国产A类模型推理功能控制 (ChinaModel Thinking Control) ---
          applyChinaModelThinkingControl(originalBody);
        } else if (DEBUG_MODE) {
          console.log(`[SemanticModelRouter] 检测到语义路由模型 '${originalModel}'，延后到消息预处理完成后选择真实后端模型。`);
        }
      }

      await writeDebugLog('LogInput', originalBody);

      const vcpToolUseForbidden = consumeVcpToolUseForbiddenPlaceholder(originalBody.messages);
      if (vcpToolUseForbidden && DEBUG_MODE) {
        console.log(`[VCPToolUse] Detected ${VCP_TOOL_USE_FORBIDDEN_PLACEHOLDER} in top-level system prompt. Tool parsing/execution is disabled for this request.`);
      }

      let shouldProcessMedia = false;
      let shouldProcessMediaPlus = false;
      if (originalBody.messages && Array.isArray(originalBody.messages)) {
        for (const msg of originalBody.messages) {
          let foundPlaceholderInMsg = false;
          let foundPlusPlaceholderInMsg = false;
          if (msg.role === 'user' || msg.role === 'system') {
            if (typeof msg.content === 'string') {
              if (msg.content.includes('{{TransBase64+}}')) {
                foundPlusPlaceholderInMsg = true;
                msg.content = msg.content.replace(/\{\{TransBase64\+\}\}/g, '');
              } else if (msg.content.includes('{{TransBase64}}')) {
                foundPlaceholderInMsg = true;
                msg.content = msg.content.replace(/\{\{TransBase64\}\}/g, '');
              }
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === 'text' && typeof part.text === 'string') {
                  if (part.text.includes('{{TransBase64+}}')) {
                    foundPlusPlaceholderInMsg = true;
                    part.text = part.text.replace(/\{\{TransBase64\+\}\}/g, '');
                  } else if (part.text.includes('{{TransBase64}}')) {
                    foundPlaceholderInMsg = true;
                    part.text = part.text.replace(/\{\{TransBase64\}\}/g, '');
                  }
                }
              }
            }
          }
          if (foundPlaceholderInMsg || foundPlusPlaceholderInMsg) {
            shouldProcessMedia = true;
            if (foundPlusPlaceholderInMsg) {
              shouldProcessMediaPlus = true;
            }
            if (DEBUG_MODE) console.log(`[Server] Media translation enabled by ${foundPlusPlaceholderInMsg ? '{{TransBase64+}}' : '{{TransBase64}}'} placeholder.`);
            // Removed break to ensure all + modifiers are processed if present in multiple messages
          }
        }
      }

      // --- VCPTavern 优先处理 ---
      // 在任何变量替换之前，首先运行 VCPTavern 来注入预设内容
      let tavernProcessedMessages = originalBody.messages;
      if (pluginManager.messagePreprocessors.has('VCPTavern')) {
        if (DEBUG_MODE) console.log(`[Server] Calling priority message preprocessor: VCPTavern`);
        try {
          tavernProcessedMessages = await pluginManager.executeMessagePreprocessor('VCPTavern', originalBody.messages, requestPreprocessorConfig);
        } catch (pluginError) {
          console.error(`[Server] Error in priority preprocessor VCPTavern:`, pluginError);
        }
      }

      // --- 语义模型路由：在变量替换前确定真实后端模型 ---
      // 这一步必须放在 VCPTavern 之后、变量替换之前：
      // 1) 路由依据已经包含 Tavern 注入的最新 user/assistant 上下文，更贴近真实意图。
      // 2) 在变量替换前完成，使后续的 SarPrompt、ChinaModel 等模型相关注入能针对真实路由模型生效。
      let semanticRoutePlan = null;
      let semanticModelFallbackCandidates = null;
      if (semanticModelRouter && typeof semanticModelRouter.isRoutingModel === 'function' && semanticModelRouter.isRoutingModel(originalBody.model)) {
        semanticRoutePlan = await semanticModelRouter.resolveRoute({
          requestedModel: originalBody.model,
          messages: tavernProcessedMessages,
          pluginManager
        });

        if (semanticRoutePlan && semanticRoutePlan.active) {
          const rawCandidates = Array.isArray(semanticRoutePlan.candidates) && semanticRoutePlan.candidates.length > 0
            ? semanticRoutePlan.candidates
            : [semanticRoutePlan.selectedModel];

          semanticModelFallbackCandidates = rawCandidates
            .map(model => modelRedirectHandler.redirectModelForBackend(model))
            .filter(Boolean)
            .filter((model, index, arr) => arr.indexOf(model) === index);

          const selectedBackendModel = semanticModelFallbackCandidates[0] || modelRedirectHandler.redirectModelForBackend(semanticRoutePlan.selectedModel);
          const previousModel = originalBody.model;
          originalBody = { ...originalBody, model: selectedBackendModel };

          if (DEBUG_MODE || previousModel !== selectedBackendModel) {
            console.log(
              `[SemanticModelRouter] 请求模型 '${previousModel}' 已路由到 '${selectedBackendModel}' ` +
              `(preset=${semanticRoutePlan.presetName}, reason=${semanticRoutePlan.reason}, candidates=${semanticModelFallbackCandidates.join(' -> ')})`
            );
          }

          applyChinaModelThinkingControl(originalBody);
        }
      }

      // --- 纯文本模型强制翻译多模态 ---
      // 当语义路由 / ModelRedirect 解析后的真实后端模型命中
      // MultiModalForceTranslateModels 列表（不区分大小写、tag 子串匹配）时：
      // 1) 自动开启多模态翻译（无视用户是否配置 {{TransBase64}}/{{TransBase64+}}）
      // 2) 强制关闭 + 模式的 base64 还原（因为目标模型是纯文本模型，无法处理 base64）
      // 3) 初始请求仍仅在消息确实含有 base64 多模态时执行翻译，避免空转翻译插件
      // 4) 该标记也会传递给 VCP loop，用于工具回包后才出现 image_url 的情况
      const isTextOnlyForceTranslateModel = Array.isArray(multiModalForceTranslateModels) &&
        multiModalForceTranslateModels.length > 0 &&
        isTextOnlyModelByTag(originalBody.model, multiModalForceTranslateModels);
      if (
        isTextOnlyForceTranslateModel &&
        messagesContainBase64Media(tavernProcessedMessages)
      ) {
        const previousMode = shouldProcessMediaPlus ? 'TransBase64+' : (shouldProcessMedia ? 'TransBase64' : 'none');
        shouldProcessMedia = true;
        shouldProcessMediaPlus = false; // 关键：禁用还原 base64
        console.log(
          `[MultiModalForceTranslate] 模型 '${originalBody.model}' 命中纯文本模型 tag 列表，` +
          `自动启用多模态文本翻译并禁用 base64 还原（先前模式: ${previousMode}）。`
        );
      }

      // --- 统一处理所有变量替换 ---
      // 创建一个包含所有所需依赖的统一上下文
      const processingContext = {
        pluginManager,
        webSocketServer,
        cachedEmojiLists: this.config.cachedEmojiLists,
        detectors: this.config.detectors,
        superDetectors: this.config.superDetectors,
        DEBUG_MODE,
        messages: tavernProcessedMessages, // 将近期消息列表传递下去，用于支持上下文动态折叠 (Contextual Folding)
        // 静态/混合/分布式插件上报内容由 preprocessor_order.json 中的
        // $StaticPlaceholderInjection 虚拟阶段注入，避免动态网页文本在
        // CapturePreprocessor 之前生成可执行截图占位符。
        deferStaticPluginPlaceholders: true,
        // 🔒 灵魂级占位符去重：跨消息共享展开状态
        // Agent 类：整个上下文只允许展开一个 agent（第一个遇到的），后续所有 agent 占位符均不展开
        // Toolbox 类：每种 toolbox 各允许展开一次，同名重复出现时不再展开
        // VCP 工具 / 静态插件 / 全局清单类：每种在整个请求生命周期内只展开一次
        expandedAgentName: null,    // string | null - 已展开的唯一 Agent 别名
        expandedToolboxes: new Set(), // Set<string> - 已展开的 Toolbox 别名集合
        expandedVcpTools: new Set(), // Set<string> - 已展开的 VCP 工具别名集合
        expandedStaticPlaceholders: new Set(), // Set<string> - 已展开的静态插件占位符集合
        expandedGlobalPlaceholders: new Set() // Set<string> - 已展开的全局清单占位符集合
      };

      // 🔒 顺序处理消息（非并发），确保 agent/toolbox 的"首次展开"语义正确
      // 如果使用 Promise.all 并发，多条消息可能同时展开同一个 agent，违反"只展开一个"的约束
      let processedMessages = [];
      for (const msg of tavernProcessedMessages) {
        const newMessage = JSON.parse(JSON.stringify(msg));
        if (newMessage.content && typeof newMessage.content === 'string') {
          newMessage.content = await messageProcessor.replaceAgentVariables(
            newMessage.content,
            originalBody.model,
            msg.role,
            processingContext,
          );
        } else if (Array.isArray(newMessage.content)) {
          const newParts = [];
          for (const part of newMessage.content) {
            if (part.type === 'text' && typeof part.text === 'string') {
              const newPart = JSON.parse(JSON.stringify(part));
              newPart.text = await messageProcessor.replaceAgentVariables(
                newPart.text,
                originalBody.model,
                msg.role,
                processingContext,
              );
              newParts.push(newPart);
            } else {
              newParts.push(part);
            }
          }
          newMessage.content = newParts;
        }
        processedMessages.push(newMessage);
      }
      processedMessages = copyArrayMetadata(
        tavernProcessedMessages,
        processedMessages
      );
      if (DEBUG_MODE) await writeDebugLog('LogAfterVariableProcessing', processedMessages);

      // --- 可排序消息处理管线 ---
      // VCPTavern 已在变量展开前执行；其余真实预处理器与静态占位符注入
      // 严格遵循 preprocessor_order.json，确保动态插件文本不能污染前置捕获指令。
      const STATIC_PLACEHOLDER_INJECTION_STAGE = '$StaticPlaceholderInjection';
      const selectedMediaProcessor = pluginManager.messagePreprocessors.has('MultiModalProcessor')
        ? 'MultiModalProcessor'
        : 'ImageProcessor';
      const orderedPipeline = Array.isArray(pluginManager.preprocessorOrder)
        ? pluginManager.preprocessorOrder
        : Array.from(pluginManager.messagePreprocessors.keys());

      for (const name of orderedPipeline) {
        if (name === 'VCPTavern') continue;
        if (presence?.handles(name)) continue;

        if (name === STATIC_PLACEHOLDER_INJECTION_STAGE) {
          if (DEBUG_MODE) console.log('[Server] Injecting static/hybrid/distributed plugin placeholders.');
          const messagesBeforeProcessor = processedMessages;
          processedMessages = copyArrayMetadata(
            messagesBeforeProcessor,
            await messageProcessor.injectStaticPluginPlaceholdersInMessages(
              processedMessages,
              {
                ...processingContext,
                messages: processedMessages
              }
            )
          );
          continue;
        }

        if (name === 'ImageProcessor' || name === 'MultiModalProcessor') {
          if (!shouldProcessMedia || name !== selectedMediaProcessor) continue;
        }

        if (!pluginManager.messagePreprocessors.has(name)) continue;

        // Capture may have added media earlier in this ordered pipeline.
        // Back up at the consuming stage, not before all preprocessors.
        if (shouldProcessMediaPlus && name === selectedMediaProcessor) {
          for (const msg of processedMessages) {
            if (msg.role === 'user' && Array.isArray(msg.content)) {
              const mediaParts = msg.content.filter(part => part.type === 'image_url' && typeof part.image_url?.url === 'string' && /^data:(image|audio|video)\/[^;]+;base64,/.test(part.image_url.url));
              if (mediaParts.length > 0) {
                msg.__vcp_media_backup__ = JSON.parse(JSON.stringify(mediaParts));
              }
            }
          }
        }

        if (DEBUG_MODE) console.log(`[Server] Calling message preprocessor: ${name}`);
        try {
          const messagesBeforeProcessor = processedMessages;
          processedMessages = copyArrayMetadata(
            messagesBeforeProcessor,
            await pluginManager.executeMessagePreprocessor(
              name,
              processedMessages,
              requestPreprocessorConfig
            )
          );
        } catch (pluginError) {
          console.error(`[Server] Error in preprocessor ${name}:`, pluginError);
        }
      }
      if (presence) {
        processedMessages = await presence.inject(processedMessages, pluginManager, requestPreprocessorConfig, copyArrayMetadata);
      }
      if (DEBUG_MODE) await writeDebugLog('LogAfterPreprocessors', processedMessages);

      // --- TransBase64+ Cleanup & Restore ---
      if (shouldProcessMediaPlus) {
        for (const msg of processedMessages) {
          if (msg.role === 'user') {
            // Remove the info block
            if (typeof msg.content === 'string') {
              msg.content = msg.content.replace(/<VCP_MULTIMODAL_INFO>[\s\S]*?<\/VCP_MULTIMODAL_INFO>/g, '');
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === 'text' && typeof part.text === 'string') {
                  part.text = part.text.replace(/<VCP_MULTIMODAL_INFO>[\s\S]*?<\/VCP_MULTIMODAL_INFO>/g, '');
                }
              }
            }

            // Restore the backup
            if (msg.__vcp_media_backup__) {
              if (typeof msg.content === 'string') {
                msg.content = [
                  { type: 'text', text: msg.content },
                  ...msg.__vcp_media_backup__
                ];
              } else if (Array.isArray(msg.content)) {
                const presentMedia = new Set(msg.content.filter(part => part.type === 'image_url').map(part => part.image_url?.url));
                msg.content = [
                  ...msg.content,
                  ...msg.__vcp_media_backup__.filter(part => !presentMedia.has(part.image_url?.url))
                ];
              }
              delete msg.__vcp_media_backup__;
            }
          }
        }
        if (DEBUG_MODE) console.log(`[Server] TransBase64+ cleanup and media restore complete.`);
      }

      // --- Detector / SuperDetector 后置处理 ---
      // 保证所有消息预处理器执行完成后，再统一应用 Detector 与 SuperDetector；
      // Role Divider 必须在其后作为最终消息拆分步骤。
      // Detector 会返回 fresh array；必须显式保护 OneRing 等预处理器挂在数组上的非枚举元数据。
      const messagesBeforeDetectors = processedMessages;
      processedMessages = copyArrayMetadata(
        messagesBeforeDetectors,
        messageProcessor.applyDetectorsToMessages(processedMessages, processingContext)
      );
      if (DEBUG_MODE) await writeDebugLog('LogAfterDetectors', processedMessages);

      // --- 角色分割处理 (Role Divider) - 最终阶段 ---
      if (enableRoleDivider) {
        if (DEBUG_MODE) console.log('[Server] Applying Role Divider processing (Final Stage)...');
        // skipCount: 1 to exclude the initial SystemPrompt from splitting
        const messagesBeforeRoleDivider = processedMessages;
        processedMessages = copyArrayMetadata(
          messagesBeforeRoleDivider,
          roleDivider.process(processedMessages, {
            ignoreList: roleDividerIgnoreList,
            switches: roleDividerSwitches,
            scanSwitches: roleDividerScanSwitches,
            removeDisabledTags: roleDividerRemoveDisabledTags,
            skipCount: 1
          })
        );
        if (DEBUG_MODE) await writeDebugLog('LogAfterFinalRoleDivider', processedMessages);
      }

      presence?.bind(processedMessages, pluginManager);

      // Keep internal speaker names for native consumers; project display names at the Provider boundary.
      originalBody.messages = processedMessages;

      let oneRingResponseMeta = null;
      try {
        const oneRingModule = pluginManager?.messagePreprocessors?.get?.('OneRing');
        if (oneRingModule && typeof oneRingModule.extractMetaFromMessages === 'function') {
          oneRingResponseMeta = oneRingModule.extractMetaFromMessages(processedMessages);
          if (DEBUG_MODE && oneRingResponseMeta) {
            console.log(`[OneRing] Frozen response meta before upstream fetch: agent=${oneRingResponseMeta.agentName} frontend=${oneRingResponseMeta.frontendSource} turn=${oneRingResponseMeta.turnId || 'none'}`);
          }
        }
      } catch (oneRingMetaError) {
        console.warn('[OneRing] Failed to freeze response meta before upstream fetch:', oneRingMetaError.message);
      }
      presence?.confirmOneRing(oneRingResponseMeta);

      interactionCompletion = sink.beginInteraction({
        signal: abortController.signal,
        oneRingModule: pluginManager?.messagePreprocessors?.get?.('OneRing'),
        oneRingMeta: oneRingResponseMeta,
        messages: processedMessages,
        tavernInteraction: requestPreprocessorConfig.tavernInteraction
      });

      const willStreamResponse = isOriginalRequestStreaming;
      const finalUpstreamBody = projectToolBatchForUpstream({ ...originalBody, stream: willStreamResponse });

      finalContextStore.setLastFinalContext(finalUpstreamBody, {
        requestId: body.requestId || null,
        messageId: body.messageId || null,
        clientIp,
        forceShowVCP,
        capturedStage: 'before_upstream_fetch'
      });

      await writeDebugLog('LogOutputAfterProcessing', finalUpstreamBody);

      const requestFetchWithRetry = presence?.wrapFetch(fetchWithRetry) || fetchWithRetry;

      let firstAiAPIResponse = await requestFetchWithRetry(
        `${apiUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...(userAgent && { 'User-Agent': userAgent }),
            Accept: willStreamResponse ? 'text/event-stream' : acceptHeader || 'application/json',
          },
          body: JSON.stringify(finalUpstreamBody),
          signal: abortController.signal,
        },
        {
          retries: apiRetries,
          delay: apiRetryDelay,
          debugMode: DEBUG_MODE,
          connectionTimeout: apiConnectionTimeoutMs,
          modelFallbackCandidates: semanticModelFallbackCandidates,
          onRetry: attempt => sink.onUpstreamRetry?.({ stream: isOriginalRequestStreaming, debug: DEBUG_MODE, attempt }),
        },
      );

      const isUpstreamStreaming =
        willStreamResponse && firstAiAPIResponse.headers.get('content-type')?.includes('text/event-stream');

      if (!await sink.beginUpstream(firstAiAPIResponse, {
        originalBody, isOriginalRequestStreaming, signal, writeChatLog
      })) return { completed: false };

      const context = {
        ...this.config,
        toolExecutor: this.toolExecutor,
        ToolCallParser,
        abortController,
        originalBody,
        clientIp,
        forceShowVCP,
        _refreshRagBlocksIfNeeded,
        fetchWithRetry: requestFetchWithRetry,
        isToolResultError,
        formatToolResult,
        vcpToolUseForbidden,
        apiConnectionTimeoutMs,
        semanticModelFallbackCandidates,
        oneRingResponseMeta,
        shouldProcessMedia,
        shouldProcessMediaPlus,
        isTextOnlyForceTranslateModel,
        requestPreprocessorConfig
      };

      const outcome = isUpstreamStreaming
        ? await new StreamHandler(context).execute(sink, firstAiAPIResponse)
        : await new NonStreamHandler(context).execute(sink, firstAiAPIResponse);
      if (outcome?.completed && !signal.aborted) sink.onModelFinal?.(outcome);
      interactionCompletion.accept(outcome);
      interactionOutcomeAccepted = true;
      return outcome;
    } catch (error) {
      if (error.name === 'AbortError' || signal.aborted) {
        return { completed: false, errorCode: 'TURN_CANCELLED' };
      }
      const toolBoundary = error.code === 'WORK_SAFE_TOOL_BOUNDARY' && nativeContext.settleToolPause();
      console.error('处理请求或转发时出错:', error.message, error.stack);
      sink.onExecutionError(error, { originalBody, isOriginalRequestStreaming, writeChatLog, toolBoundary });
      return { completed: false, errorCode: error.code || 'TURN_FAILED' };
    } finally {
      if (!interactionOutcomeAccepted) interactionCompletion?.fail();
    }
  }
}

// 暴露纯刷新入口供安全回归测试和内部复用；请求主链路仍通过 handler context 调用同一实现。
Object.defineProperty(ChatCompletionHandler, 'refreshRagBlocksIfNeeded', {
  value: _refreshRagBlocksIfNeeded,
  writable: false,
  configurable: false,
  enumerable: false
});

module.exports = ChatCompletionHandler;
