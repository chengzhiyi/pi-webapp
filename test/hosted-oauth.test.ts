import assert from "node:assert/strict";
import test from "node:test";
import { DeviceFlows, secretAuthFor } from "../src/host/server/plugins/hosted/capabilities/oauth.ts";

const reply = (value: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => value });
test("secretAuthFor defaults to the built-in client id and allows an override", () => {
  assert.equal(secretAuthFor("@chengzhiyi/pi-github", "github-token", {})?.clientId, "Ov23limJmKiuu8cOP83E");
  assert.equal(secretAuthFor("@chengzhiyi/pi-github", "github-token", { PI_WEBAPP_GITHUB_CLIENT_ID: " abc " })?.clientId, "abc");
  assert.match(secretAuthFor("@chengzhiyi/pi-github", "github-token", {})!.createUrl, /^https:\/\/github\.com\/settings\/personal-access-tokens\/new\?/);
  assert.equal(secretAuthFor("other", "x", {}), undefined);
});
test("device flow: start, pending, slow_down, granted; device code never leaves the host", async () => {
  let clock = 0; const calls: string[] = []; const answers: unknown[] = [{ error: "authorization_pending" }, { error: "slow_down" }, { access_token: "gho_TOKEN" }];
  const flows = new DeviceFlows(async (url, init) => {
    calls.push(url);
    return url.endsWith("/device/code") ? reply({ device_code: "DEV", user_code: "AB-CD", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }) : (assert.match(init.body, /device_code=DEV/), reply(answers.shift()));
  }, () => clock);
  const started = await flows.start("p", "github-token", { clientId: "cid", scope: "repo", createUrl: "https://github.com" });
  assert.equal(started.userCode, "AB-CD"); assert.ok(!JSON.stringify(started).includes("DEV"));
  assert.deepEqual(await flows.poll(started.deviceId), { status: "pending" }); assert.equal(calls.length, 1, "polling faster than the interval does not call GitHub");
  clock += 5_000; assert.deepEqual(await flows.poll(started.deviceId), { status: "pending" });
  clock += 5_000; assert.deepEqual(await flows.poll(started.deviceId), { status: "pending" }, "slow_down backs off");
  clock += 5_000; assert.deepEqual(await flows.poll(started.deviceId), { status: "pending" }, "interval grew to 10 s");
  clock += 5_000; assert.deepEqual(await flows.poll(started.deviceId), { status: "granted", token: "gho_TOKEN", pluginId: "p", name: "github-token" });
  assert.deepEqual(await flows.poll(started.deviceId), { status: "expired" }, "a finished flow cannot be replayed");
});
test("device flow: denial, expiry, missing client id, unreachable GitHub", async () => {
  let clock = 0;
  const flows = new DeviceFlows(async url => url.endsWith("/device/code") ? reply({ device_code: "D", user_code: "U", verification_uri: "https://github.com/login/device", expires_in: 60, interval: 1 }) : reply({ error: "access_denied" }), () => clock);
  const auth = { clientId: "cid", scope: "repo", createUrl: "https://github.com" };
  const denied = await flows.start("p", "n", auth); clock += 1000;
  assert.deepEqual(await flows.poll(denied.deviceId), { status: "denied" });
  const expired = await flows.start("p", "n", auth); clock += 61_000;
  assert.deepEqual(await flows.poll(expired.deviceId), { status: "expired" });
  await assert.rejects(flows.start("p", "n", { ...auth, clientId: undefined }), /not configured/);
  await assert.rejects(new DeviceFlows(async () => { throw new Error("down"); }).start("p", "n", auth), /Cannot reach github\.com/);
  await assert.rejects(new DeviceFlows(async () => reply({ device_code: "D", user_code: "U", verification_uri: "https://evil.example/x", expires_in: 60 })).start("p", "n", auth), /could not start/);
});
