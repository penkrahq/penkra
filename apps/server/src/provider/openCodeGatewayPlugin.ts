// The one native host tool is derived from its canonical contract.
import type { McpToolDefinition } from "../agentGateway/protocol.ts";
import { MCP_DEFAULT_PROTOCOL_VERSION } from "../agentGateway/protocol.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PENKRA_EXEC_COMMAND_NAME,
  PENKRA_EXEC_COMMAND_ZOD_SHAPE,
} from "../agentGateway/hostToolContract.ts";

export function openCodeGatewayPluginSource(definitions: ReadonlyArray<McpToolDefinition>): string {
  const definition = definitions[0];
  if (definitions.length !== 1 || definition?.name !== PENKRA_EXEC_COMMAND_NAME)
    throw new Error("The native gateway surface must match the canonical host tool.");
  const command = PENKRA_EXEC_COMMAND_ZOD_SHAPE.command;
  if (command.minLength === null)
    throw new Error("The canonical host command requires a length constraint.");
  const args = `{command:s.string().min(${command.minLength}).describe(${JSON.stringify(command.description)})}`;
  const tool = `${JSON.stringify(definition.name)}:{description:${JSON.stringify(definition.description)},args:${args},execute:(args,context)=>invoke(${JSON.stringify(definition.name)},args,context)}`;
  return `import {tool} from '@opencode-ai/plugin';
import {randomUUID} from 'node:crypto';
const s=tool.schema;
async function request(method,params,context){
  if(!context.sessionID)throw new Error('The native session is unavailable.');
  const response=await fetch(process.env.PENKRA_GATEWAY_URL,{
    method:'POST',signal:context.abort,
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.PENKRA_GATEWAY_PROCESS_TOKEN,'x-penkra-native-session-id':context.sessionID},
    body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})
  });
  const body=await response.json();
  if(!response.ok||body.error)throw new Error(body.error?.message||'Penkra gateway request failed ('+response.status+').');
  return body.result;
}

async function invoke(name,args,context){
  const result=await request('tools/call',{name,arguments:args},context);
  const body={result};
  if(!Array.isArray(body.result?.content))throw new Error('Penkra gateway returned an invalid tool result.');
  const output=body.result.content.filter(part=>part.type==='text').map(part=>part.text).join('\\n');
  if(body.result.isError)throw new Error(output);
  const attachments=body.result.content.flatMap(part=>{
    if(part.type==='text')return [];
    if(part.type==='image')return [{type:'file',mime:part.mimeType,url:'data:'+part.mimeType+';base64,'+part.data}];
    if(part.type==='resource'){
      const mime=part.resource.mimeType||'application/octet-stream';
      return [{type:'file',mime,url:'data:'+mime+';base64,'+part.resource.blob,...(part.resource.name?{filename:part.resource.name}:{})}];
    }
    throw new Error('Penkra gateway returned an unsupported content block.');
  });
  return {title:name,output,metadata:{},attachments};
}
export const PenkraGateway=async()=>({
  tool:{${tool}},
  'experimental.chat.system.transform':async(input,output)=>{
    if(input.sessionID===undefined)return;
    const result=await request('initialize',{protocolVersion:${JSON.stringify(MCP_DEFAULT_PROTOCOL_VERSION)}},input);
    if(typeof result?.instructions!=='string')throw new Error('Penkra gateway returned no tool instructions.');
    output.system.push(result.instructions);
  }
});
`;
}

/** Atomic installation in the managed profile's native plugin/dependency tree. */
export async function ensureOpenCodeGatewayPlugin(
  profileRoot: string,
  definitions: ReadonlyArray<McpToolDefinition>,
): Promise<string> {
  const target = path.join(profileRoot, "xdg-config", "opencode", "plugins", "penkra-gateway.js");
  const source = openCodeGatewayPluginSource(definitions);
  const previous = await readFile(target, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (previous === source) return target;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}
