declare const __PI_WEB_RELEASE__: string;
declare const __PI_WEB_BUILD_ID__: string;
export const release = typeof __PI_WEB_RELEASE__ === "string" ? __PI_WEB_RELEASE__ : "pi-webapp@development";
export const buildId = typeof __PI_WEB_BUILD_ID__ === "string" ? __PI_WEB_BUILD_ID__ : "development";
