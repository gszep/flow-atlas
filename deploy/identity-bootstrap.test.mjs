import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./setup-github-identity.sh", import.meta.url));

async function harness(existing = false) {
	const root = await mkdtemp(join(tmpdir(), "flow-wif-test-"));
	const log = join(root, "commands.jsonl");
	for (const name of ["gcloud", "gh"]) {
		const file = join(root, name);
		await writeFile(
			file,
			`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2),name=${JSON.stringify(name)};
fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify({name,args})+'\\n');
if(name==='gh'&&args[0]==='api') console.log(args.includes('.owner.id')?'17977117':'1134103744');
if(name==='gcloud'&&args.includes('describe')) {
  if(args.includes('projects')) console.log('425855636482');
  else if(process.env.EXISTING_PROVIDER==='1') { if(args.includes('providers')) console.log('different trust'); }
  else process.exit(1);
}
`,
		);
		await chmod(file, 0o700);
	}
	return {
		root,
		log,
		env: {
			...process.env,
			PATH: `${root}:${process.env.PATH}`,
			COMMAND_LOG: log,
			GCLOUD_CONFIGURATION: "unit-test",
			EXISTING_PROVIDER: existing ? "1" : "0",
		},
	};
}

test("identity bootstrap binds only this repository/main workflow and creates no service-account keys", async () => {
	const h = await harness();
	try {
		await run("bash", [script], { env: h.env });
		const calls = (await readFile(h.log, "utf8")).trim().split("\n").map(JSON.parse);
		const create = calls.find((call) => call.args.includes("create-oidc"));
		const condition = create.args.find((arg) => arg.startsWith("--attribute-condition="));
		assert.match(condition, /repository_id == '1134103744'/);
		assert.match(condition, /repository_owner_id == '17977117'/);
		assert.match(condition, /refs\/heads\/main/);
		assert.match(condition, /gszep\/flow-atlas\/\.github\/workflows\/ci\.yml/);
		assert.equal(
			calls.some((call) => call.args.includes("keys") || call.args.includes("print-access-token")),
			false,
		);
		const delegated = calls.filter((call) =>
			call.args.includes("--role=roles/iam.serviceAccountUser"),
		);
		assert.equal(delegated.length, 2);
		assert.ok(
			delegated.every((call) =>
				call.args.some((arg) => /^flow-atlas-demo-(runtime|build)@/.test(arg)),
			),
		);
		assert.deepEqual(
			calls
				.filter((call) => call.name === "gh" && call.args[0] === "variable")
				.map((call) => call.args[2]),
			["FLOW_GCP_WIF_PROVIDER", "FLOW_GCP_DEPLOY_ACCOUNT"],
		);
	} finally {
		await rm(h.root, { recursive: true, force: true });
	}
});

test("identity bootstrap does not overwrite an existing different provider trust", async () => {
	const h = await harness(true);
	try {
		await assert.rejects(run("bash", [script], { env: h.env }), /different trust condition/);
		const calls = (await readFile(h.log, "utf8")).trim().split("\n").map(JSON.parse);
		assert.equal(
			calls.some((call) => call.args.includes("update-oidc") || call.args[0] === "variable"),
			false,
		);
	} finally {
		await rm(h.root, { recursive: true, force: true });
	}
});
