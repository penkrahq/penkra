import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
const repo = process.env.QA_REPO;
const ranges = {
  "apps/server/src/appRuntimeCli.ts": [
    [628, 674],
    [1010, 1040],
    [1048, 1200],
    [1205, 1345],
    [1410, 1500],
  ],
  "apps/desktop/src/appCommandPipeServer.ts": [
    [1, 50],
    [385, 393],
    [479, 550],
    [915, 941],
    [979, 983],
    [1030, 1072],
    [1087, 1093],
    [1120, 1200],
  ],
  "apps/desktop/src/appTabObserver.ts": [
    [1, 1960],
    [1994, 2025],
    [2120, 2140],
  ],
  "apps/desktop/src/appTabActivation.ts": [[1, 110]],
  "apps/desktop/src/appTabOpenedRouting.ts": [[65, 90]],
  "apps/desktop/src/browserUploadFile.ts": [[1, 100]],
  "apps/desktop/src/main.ts": [
    [543, 585],
    [8240, 8290],
  ],
  "apps/desktop/src/appTabViewHost.ts": [
    [960, 965],
    [1135, 1146],
    [2018, 2023],
    [2730, 2740],
  ],
};
let result = [];
for (const [file, intervals] of Object.entries(ranges)) {
  const source = fs.readFileSync(path.join(repo, file), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    const isError = ts.isNewExpression(node) && node.expression.getText(tree) === "Error";
    const isHelper =
      ts.isCallExpression(node) &&
      ["observerError", "visualUnavailable"].includes(node.expression.getText(tree));
    if ((isError || isHelper) && intervals.some(([a, b]) => line >= a && line <= b))
      result.push({
        source: file,
        line,
        expression: node.getText(tree),
        verdict: "ambiguous",
        evidence:
          "Source branch only; this exact failure precondition was not produced in native runtime.",
      });
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
fs.writeFileSync(
  path.join(process.env.QA_ROOT, "evidence/error-catalog.json"),
  JSON.stringify(result, null, 2),
);
