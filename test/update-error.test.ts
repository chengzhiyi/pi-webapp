import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../web/src/http-error.ts";
import { updateErrorMessage } from "../web/src/ui/settings/update-error.ts";

test("old bridge 404 explains that the service must restart", () => {
  const error = new HttpError("未找到", 404);
  assert.match(updateErrorMessage(error, "zh", "check"), /旧版.*重启 pi-webapp/);
  assert.match(updateErrorMessage(error, "en", "check"), /older version.*Restart pi-webapp/);
  assert.doesNotMatch(updateErrorMessage(error, "zh", "check"), /未找到/);
});

test("other update errors keep their useful detail", () => {
  assert.equal(updateErrorMessage(new HttpError("npm 暂不可用", 503), "zh", "check"), "npm 暂不可用");
  assert.equal(updateErrorMessage(null, "en", "install"), "Update failed");
});
