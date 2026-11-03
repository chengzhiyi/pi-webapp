import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../src/host/client/http-error.ts";
import { updateErrorMessage } from "../web/src/ui/settings/update-error.ts";

test("old bridge 404 explains that the service must restart", () => {
  const error = new HttpError("未找到", 404);
  assert.match(updateErrorMessage(error, "zh", "check"), /旧版.*重启 pi-webapp/);
  assert.match(updateErrorMessage(error, "en", "check"), /older version.*Restart pi-webapp/);
  assert.doesNotMatch(updateErrorMessage(error, "zh", "check"), /未找到/);
});

test("busy update errors are localized without changing the Chinese original", () => {
  const cause = new HttpError("请等待当前回复结束后再升级", 409);
  assert.equal(updateErrorMessage(cause, "en", "install"), "Wait for the current reply to finish before updating.");
  assert.equal(updateErrorMessage(cause, "zh", "install"), "请等待当前回复结束后再升级");
  assert.equal(updateErrorMessage(new HttpError("请等待所有聊天任务结束后再升级", 409), "en", "install"), "Wait for all chat tasks to finish before updating.");
});

test("other update errors keep their useful detail", () => {
  assert.equal(updateErrorMessage(new HttpError("npm 暂不可用", 503), "zh", "check"), "npm 暂不可用");
  assert.equal(updateErrorMessage(null, "en", "install"), "Update failed");
});
