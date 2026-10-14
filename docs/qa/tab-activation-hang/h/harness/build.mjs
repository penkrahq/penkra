import path from "node:path";
const result=await Bun.build({entrypoints:[process.env.QA_ENTRY ?? "qa/main-commands.ts"],outdir:"qa/bundle",target:"node",format:"cjs",external:["electron"],plugins:[{name:"qa-raw",setup(build){build.onResolve({filter:/\.md\?raw$/},args=>({path:path.resolve(args.resolveDir,args.path.slice(0,-4)),namespace:"raw-md"}));build.onLoad({filter:/.*/,namespace:"raw-md"},async args=>({contents:"export default "+JSON.stringify(await Bun.file(args.path).text()),loader:"js"}));}}]});
if(!result.success){for(const error of result.logs)console.error(error);process.exit(1)}
console.log(result.outputs.map(output=>output.path));

await Bun.write("qa/bundle/main.cjs", await result.outputs[0].text());
await Bun.write("qa/bundle/package.json", JSON.stringify({name:"penkra-activation-diagnostic-harness",main:"main.cjs"}));
