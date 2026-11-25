'use strict';

const { createInteractionCompletion } = require('./interactionCompletion');
const {
  createPresentationChannel,
  createStreamPresentationSink,
  createNonStreamPresentationSink,
  attachNonStreamPresentations
} = require('../vcpLoop/residentPresentation');

class HttpTurnSink {
  constructor(req, res) {
    this.req = req;
    this.res = res;
    this.presentations = [];
  }

  isClosed() { return this.res.writableEnded || this.res.destroyed; }
  isDestroyed() { return this.res.destroyed; }
  hasEnded() { return this.res.writableEnded; }
  disableReplay() { this.res.__vcpDisableReplayCache?.(); }
  onProtocolFrame(frame) { return this.res.write(frame); }
  onDelta({ rawLine }) { return this.res.write(rawLine); }
  onToolBatchDisplay(_content, frame) { this.res.write(frame); }
  endStream(frame) { this.res.end(frame); }
  onNonStreamResponse(response) {
    this.res.send(Buffer.from(JSON.stringify(attachNonStreamPresentations(response, this.presentations))));
  }
  observeAssistantText(text) { this.req.nativeSyncObserveAssistantText?.(text); }

  createPresentationSink({ stream, model }) {
    const res = this.res;
    const channelId = createPresentationChannel(res, true);
    return stream
      ? createStreamPresentationSink({ channelId, model, res })
      : createNonStreamPresentationSink({ channelId, presentations: this.presentations, res });
  }

  beginInteraction(details) { return createInteractionCompletion({ res: this.res, ...details }); }

  onUpstreamRetry({ stream, debug, attempt }) {
    const res = this.res;
    if (res.headersSent || !stream) return;
    if (debug) console.log(`[VCP Retry] First retry attempt (#${attempt}). Sending 200 OK to client to establish stream.`);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }

  async beginUpstream(firstAiAPIResponse, { originalBody, isOriginalRequestStreaming, signal, writeChatLog }) {
    const res = this.res;
      if (!res.headersSent) {
        const upstreamStatus = firstAiAPIResponse.status;

        if (isOriginalRequestStreaming && upstreamStatus !== 200) {
          // If streaming was requested, but upstream returned a non-200 status (e.g., 400, 401, 502, 504),
          // we must return 200 OK and stream the error as an SSE chunk to prevent client listener termination.
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          // The text frame remains display-compatible. Side requests use the actual status.
          res.setHeader('X-VCP-Upstream-Status', String(upstreamStatus));
          const exposed = res.getHeader('Access-Control-Expose-Headers');
          res.setHeader('Access-Control-Expose-Headers', [exposed, 'X-VCP-Upstream-Status'].filter(Boolean).join(', '));

          // Read the error body from the upstream response
          const errorBodyText = await firstAiAPIResponse.text();
          signal.throwIfAborted();

          // Log the error
          console.error(`[Upstream Error Stream Proxy] Upstream API returned status ${upstreamStatus}. Streaming error to client: ${errorBodyText}`);

          // Construct the error message for the client
          const errorContent = `[UPSTREAM_ERROR] 上游API返回状态码 ${upstreamStatus}，错误信息: ${errorBodyText}`;

          // Send an error chunk
          const errorPayload = {
            id: `chatcmpl-VCP-upstream-error-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalBody.model || 'unknown',
            choices: [
              {
                index: 0,
                delta: {
                  content: errorContent,
                },
                finish_reason: 'stop',
              },
            ],
          };
          try {
            res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
            res.end('data: [DONE]\n\n');
          } catch (writeError) {
            console.error('[Upstream Error] Failed to write error to stream:', writeError.message);
            if (!res.writableEnded) {
              try {
                res.end();
              } catch (endError) {
                console.error('[Upstream Error] Failed to end response:', endError.message);
              }
            }
          }

          if (writeChatLog) {
            writeChatLog(originalBody,
              [ {
                request: originalBody,
                response: { error: true, status: upstreamStatus, body: errorBodyText }
              } ]);
          }
          // We are done with this request. Return early.
          return false;
        }

        // Normal header setting for non-streaming or successful streaming responses
        res.status(upstreamStatus);
        firstAiAPIResponse.headers.forEach((value, name) => {
          if (
            !['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive', 'x-vcp-upstream-status'].includes(
              name.toLowerCase(),
            )
          ) {
            res.setHeader(name, value);
          }
        });
        if (isOriginalRequestStreaming && !res.getHeader('Content-Type')?.includes('text/event-stream')) {
          res.setHeader('Content-Type', 'text/event-stream');
          if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
          if (!res.getHeader('Connection')) res.setHeader('Connection', 'keep-alive');
        }
      }


    return true;
  }

  onExecutionError(error, { originalBody, isOriginalRequestStreaming, writeChatLog, toolBoundary }) {
    const res = this.res;
      if (toolBoundary) {
        res.__vcpDisableReplayCache?.();
        const state = toolBoundary === 'awaiting_native_task' ? toolBoundary : 'paused';
        const payload = { nativeSync: { state, code: error.code, requestId: originalBody.requestId } };
        if (!res.writableEnded && !res.destroyed) {
          if (res.headersSent) {
            res.end(`event: nativesync_work_paused\ndata: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
          } else {
            res.status(409).json(payload);
          }
        }
        return;
      }
      // Only log full stack trace for non-abort errors
      console.error('处理请求或转发时出错:', error.message, error.stack);

      if (!res.headersSent) {
        if (isOriginalRequestStreaming) {
          // If streaming was requested but failed before headers were sent (e.g., fetchWithRetry failed),
          // send a 200 status and communicate the error via SSE chunks to prevent the client from stopping listening.
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const errorContent = `[ERROR] 代理服务器在连接上游API时失败，可能已达到重试上限或网络错误: ${error.message}`;

          // Send an error chunk
          const errorPayload = {
            id: `chatcmpl-VCP-error-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalBody.model || 'unknown',
            choices: [
              {
                index: 0,
                delta: {
                  content: errorContent,
                },
                finish_reason: 'stop',
              },
            ],
          };
          try {
            res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
            res.end('data: [DONE]\n\n');
          } catch (writeError) {
            console.error('[Error Handler Stream] Failed to write error:', writeError.message);
            if (!res.writableEnded && !res.destroyed) {
              try {
                res.end();
              } catch (endError) {
                console.error('[Error Handler Stream] Failed to end response:', endError.message);
              }
            }
          }
        } else {
          // Non-streaming failure
          res.status(500).json({ error: 'Internal Server Error', details: error.message });
        }
        if (writeChatLog) {
          writeChatLog(originalBody,
            [ {
              request: originalBody,
              response: { error: true, message: error.message }
            } ]);
        }
      } else if (!res.writableEnded && !res.destroyed) {
        // Headers already sent (error during streaming loop)
        console.error(
          '[STREAM ERROR] Headers already sent. Streaming error chunk to client before ending stream:',
          error.message,
        );
        const errorContent = `\n\n> [!WARNING]\n> **流式响应中断 (上游连接异常)**: ${error.message}\n`;
        try {
          res.write(`data: ${JSON.stringify({
            id: `chatcmpl-VCP-stream-error-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalBody?.model || 'unknown',
            choices: [{ index: 0, delta: { content: errorContent }, finish_reason: 'stop' }],
          })}\n\n`);
        } catch (writeErr) {
          console.error('[Stream Error Chunk Failed]:', writeErr.message);
        }
        // Send [DONE] marker before ending the stream for graceful termination
        try {
          res.end('data: [DONE]\n\n');
        } catch (writeError) {
          console.error('[Error Handler Stream Cleanup] Failed to write [DONE]:', writeError.message);
          if (!res.writableEnded && !res.destroyed) {
            try {
              res.end();
            } catch (endError) {
              console.error('[Error Handler Stream Cleanup] Failed to end response:', endError.message);
            }
          }
        }
      }
  }
}

module.exports = HttpTurnSink;
