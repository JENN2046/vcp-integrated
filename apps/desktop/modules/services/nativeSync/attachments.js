'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { fail } = require('./protocol');
const MAX_FILE = 20 * 1024 * 1024;

class DesktopAttachments {
 async localFile(attachment){
  const raw=attachment._fileManagerData||attachment,source=raw.internalPath||attachment.internalPath||attachment.src;
  if(typeof source!=='string')throw fail('ATTACHMENT_BLOB_MISSING');
  let candidate=source;if(source.startsWith('file://')){try{candidate=fileURLToPath(source);}catch{candidate=decodeURIComponent(source.slice(7));}}
  const file=path.resolve(candidate),relative=path.relative(this.root,file);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw fail('ATTACHMENT_SOURCE_OUTSIDE_ROOT');
  let current=path.parse(this.root).root;
  for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=await fs.lstat(current);if(s.isSymbolicLink()||(s.isFile()&&s.nlink!==1))throw fail('ATTACHMENT_SOURCE_ALIAS');}
  const stat=await fs.stat(file);if(!stat.isFile()||stat.size>MAX_FILE)throw fail('ATTACHMENT_FILE_TOO_LARGE');return {file,stat};
 }
}

module.exports = { DesktopAttachments };
