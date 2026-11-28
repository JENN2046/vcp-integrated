'use strict';
const { fail } = require('./protocol');
const ruleFields=['id','name','type','enabled','content','scope','builtinKey','isBuiltin','role','depth','wrap','order','source'];
function projectRules(rules){
 if(!Array.isArray(rules)||rules.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw fail('INVALID_TAVERN_RULES');
 return rules.map(rule=>Object.fromEntries(ruleFields.filter(k=>Object.hasOwn(rule,k)).map(k=>[k,rule[k]])));
}
module.exports = { projectRules };
