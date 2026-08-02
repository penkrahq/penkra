import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scaffold } from "./cli.mjs";

test("creates complete vanilla and React App packages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-penkra-app-"));
  try {
    for (const template of ["vanilla", "react"]) {
      const result = scaffold([`${template}-app`, "--template", template], root);
      assert.equal(result.template, template);
      assert.ok(fs.existsSync(path.join(result.target, "penkra-app.json")));
      assert.ok(fs.existsSync(path.join(result.target, "README.md")));
      assert.ok(fs.existsSync(path.join(result.target, "INSTRUCTIONS.md")));
      assert.ok(fs.existsSync(path.join(result.target, template === "react" ? "src/main.jsx" : "src/app.js")));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite existing work", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-penkra-app-"));
  fs.mkdirSync(path.join(root, "occupied"));
  fs.writeFileSync(path.join(root, "occupied", "keep.txt"), "keep");
  try {
    assert.throws(() => scaffold(["occupied"], root), /Refusing to overwrite/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
