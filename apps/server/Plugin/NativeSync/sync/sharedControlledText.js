'use strict';

function allowedAgents(raw='[]'){
 let agents;try{agents=JSON.parse(raw||'[]');}catch{throw fail('INVALID_SHARED_AA_AGENTS');}
 if(!Array.isArray(agents)||agents.length>32||new Set(agents).size!==agents.length||
  agents.some(name=>typeof name!=='string'||!name||name.length>160||name.trim()!==name||/[\x00-\x1f\x7f]/.test(name)))throw fail('INVALID_SHARED_AA_AGENTS');
 return new Set(agents);
}

const fail = code => Object.assign(Error(code), { code, status: 409 });

module.exports = { allowedAgents };
