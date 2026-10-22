// Generate native tool declarations from the gateway's canonical schemas.
// Unsupported schema changes fail generation, rather than dropping validation.
import type { McpToolDefinition } from "../agentGateway/protocol.ts";
import { MCP_DEFAULT_PROTOCOL_VERSION } from "../agentGateway/protocol.ts";

const keywords = new Set([
  "$schema",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

export function openCodeSchemaExpression(schema: Record<string, unknown>): string {
  for (const key of Object.keys(schema)) {
    if (!keywords.has(key)) throw new Error(`Unsupported native gateway schema keyword: ${key}`);
  }
  let expression: string;
  if (Array.isArray(schema.type)) {
    expression = `s.union([${schema.type.map((type) => openCodeSchemaExpression({ ...schema, type, description: undefined })).join(",")}])`;
  } else if (Array.isArray(schema.enum)) {
    if (!schema.enum.length || !schema.enum.every((value) => typeof value === "string"))
      throw new Error("Native gateway enums must contain strings.");
    expression = `s.enum(${JSON.stringify(schema.enum)})`;
  } else {
    switch (schema.type) {
      case "string":
        expression = "s.string()";
        break;
      case "number":
        expression = "s.number()";
        break;
      case "integer":
        expression = "s.number().int()";
        break;
      case "boolean":
        expression = "s.boolean()";
        break;
      case "null":
        expression = "s.null()";
        break;
      case "array": {
        if (!schema.items || typeof schema.items !== "object" || Array.isArray(schema.items))
          throw new Error("Native gateway arrays require an item schema.");
        expression = `s.array(${openCodeSchemaExpression(schema.items as Record<string, unknown>)})`;
        break;
      }
      case "object": {
        const properties = schema.properties ?? {};
        if (!properties || typeof properties !== "object" || Array.isArray(properties))
          throw new Error("Native gateway objects require properties.");
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const fields = Object.entries(properties).map(([name, value]) => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("Native gateway properties require schemas.");
          return `${JSON.stringify(name)}:${openCodeSchemaExpression(value as Record<string, unknown>)}${required.has(name) ? "" : ".optional()"}`;
        });
        if (
          schema.additionalProperties !== undefined &&
          typeof schema.additionalProperties !== "boolean"
        )
          throw new Error("Native gateway additionalProperties must be boolean.");
        expression = `s.object({${fields.join(",")}}).${schema.additionalProperties === false ? "strict" : "passthrough"}()`;
        break;
      }
      default:
        throw new Error(`Unsupported native gateway schema type: ${JSON.stringify(schema.type)}`);
    }
  }
  for (const [key, method] of [
    ["minimum", "min"],
    ["maximum", "max"],
    ["minLength", "min"],
    ["maxLength", "max"],
    ["minItems", "min"],
    ["maxItems", "max"],
  ] as const) {
    if (schema[key] !== undefined) {
      if (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))
        throw new Error(`Invalid native gateway bound: ${key}`);
      expression += `.${method}(${schema[key]})`;
    }
  }
  if (schema.description !== undefined) {
    if (typeof schema.description !== "string")
      throw new Error("Native gateway descriptions must be strings.");
    expression += `.describe(${JSON.stringify(schema.description)})`;
  }
  return expression;
}

export function openCodeGatewayPluginSource(definitions: ReadonlyArray<McpToolDefinition>): string {
  const tools = definitions.map((definition) => {
    if (definition.inputSchema.type !== "object")
      throw new Error("Native gateway tools require object inputs.");
    return `${JSON.stringify(definition.name)}:{description:${JSON.stringify(definition.description)},args:(${openCodeSchemaExpression(definition.inputSchema)}).shape,execute:(args,context)=>invoke(${JSON.stringify(definition.name)},args,context)}`;
  });
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
  tool:{${tools.join(",")}},
  'experimental.chat.system.transform':async(input,output)=>{
    if(input.sessionID===undefined)return;
    const result=await request('initialize',{protocolVersion:${JSON.stringify(MCP_DEFAULT_PROTOCOL_VERSION)}},input);
    if(typeof result?.instructions!=='string')throw new Error('Penkra gateway returned no tool instructions.');
    output.system.push(result.instructions);
  }
});
`;
}
