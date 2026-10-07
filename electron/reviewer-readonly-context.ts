/** Self-contained stdio MCP server, written into the review's private temporary directory.
 * No dependency resolution or project code runs in this process. All filesystem access
 * is constrained to the real workspace root, including symlink/junction resolution.
 */
export const READONLY_CONTEXT_SERVER = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const {StringDecoder} = require('node:string_decoder');
const rootPromise = fs.realpath(process.argv[2]);
const MAX_FILE = 65536;
function reply(id, result, error) {
  process.stdout.write(JSON.stringify(error ? {jsonrpc:'2.0',id,error} : {jsonrpc:'2.0',id,result})+'\n');
}
async function resolveInside(input) {
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f]/.test(input)) throw Error('Invalid path');
  const root = await rootPromise;
  const target = await fs.realpath(path.resolve(root, input));
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw Error('Path outside review workspace');
  return target;
}
const definitions = [
  {name:'read_file',description:'Read a bounded UTF-8 text file inside the workspace. Never executes content.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
  {name:'list_directory',description:'List up to 200 entries in a workspace directory.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
  {name:'inspect_path',description:'Inspect the resolved path and file metadata inside the workspace.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}
];
for (const tool of definitions) tool.annotations={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
async function handle(message) {
  const {id,method,params} = message;
  if (id === undefined) return;
  if (method === 'initialize') return reply(id,{protocolVersion:params?.protocolVersion || '2024-11-05',capabilities:{tools:{}},serverInfo:{name:'approval-review-context',version:'1.0.0'}});
  if (method === 'ping') return reply(id,{});
  if (method === 'tools/list') return reply(id,{tools:definitions});
  if (method !== 'tools/call') return reply(id,null,{code:-32601,message:'Method not found'});
  try {
    if (!definitions.some(tool=>tool.name===params?.name)) throw Error('Unknown tool');
    const target = await resolveInside(params.arguments?.path);
    const stats = await fs.stat(target);
    let value;
    if (params.name === 'inspect_path') value = {resolvedPath:target,isFile:stats.isFile(),isDirectory:stats.isDirectory(),size:stats.size};
    else if (params.name === 'list_directory') {
      if (!stats.isDirectory()) throw Error('Not a directory');
      const entries = await fs.opendir(target); const names=[]; let truncated=false;
      for await (const entry of entries) { if(names.length===200){truncated=true;break;} names.push({name:entry.name,directory:entry.isDirectory(),symlink:entry.isSymbolicLink()}); }
      value={entries:names,truncated};
    } else {
      if (!stats.isFile()) throw Error('Not a regular file');
      const file=await fs.open(target,'r');
      try {
        const opened=await file.stat();
        if(!opened.isFile() || opened.dev!==stats.dev || opened.ino!==stats.ino || await resolveInside(target)!==target) throw Error('Path changed while opening');
        const buffer=Buffer.alloc(MAX_FILE+1);const {bytesRead}=await file.read(buffer,0,buffer.length,0);value={text:buffer.subarray(0,Math.min(bytesRead,MAX_FILE)).toString('utf8'),truncated:bytesRead>MAX_FILE};
      }
      finally { await file.close(); }
    }
    reply(id,{content:[{type:'text',text:JSON.stringify(value)}]});
  } catch(error) { reply(id,{isError:true,content:[{type:'text',text:error.message}]}); }
}
let count=0;
// Bound total work and in-flight reads; newline framing is the MCP stdio transport.
let chain=Promise.resolve();
let pending='';const decoder=new StringDecoder('utf8');
process.stdin.on('data',chunk=>{
  pending+=decoder.write(chunk);
  let newline;
  while((newline=pending.indexOf('\n'))>=0){
    const line=pending.slice(0,newline);pending=pending.slice(newline+1);
    if(line.length>131072 || ++count>256){process.exitCode=1;process.stdin.destroy();return;}
    chain=chain.then(async()=>{try{await handle(JSON.parse(line));}catch{reply(null,null,{code:-32700,message:'Parse error'});}});
  }
  if(pending.length>131072){process.exitCode=1;process.stdin.destroy();}
});
`
