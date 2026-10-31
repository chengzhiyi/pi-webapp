import { test, expect } from "@playwright/test";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

for (const build of [12,13]) test.describe(`desktop build ${build}`,()=>{
  test.use({userAgent:build===13?"Test PiDesktop/0.1.39 PiDesktopBuild/13":"Test pi/0.1.39 Electron/41.0.0"});
  test("distinguishes the window, launcher and package; offers handoff without bypassing old capabilities",async({page})=>{
    const {host}=terminalHost();const bridge=await startBridge(host,new URL('../../web/dist',import.meta.url).pathname);let handedOff=false;let supported=true;
    const status=()=>({current:"0.1.46",latest:handedOff?"0.1.47-alpha.1":null,channel:"alpha",available:handedOff,canRestart:handedOff,
      desktopShell:{version:handedOff?"0.1.39":"0.1.28",build:handedOff?"13":"10"},launcher:{version:"0.1.46",releaseChannels:handedOff,packageUpdates:true,handoffProtocol:supported?1:0},launcherHandoff:{supported,required:!handedOff},reason:handedOff?undefined:"The backend still uses the previous desktop launcher"});
    try {
      await page.addInitScript(()=>localStorage.setItem('pi-web-locale','en'));
      await page.route('**/api/update',route=>route.fulfill({json:status()}));
      await page.goto(bridge.url);await page.getByRole('button',{name:'Pi Settings',exact:true}).click();
      await expect(page.getByText('Backend launcher 0.1.46 · Preview persistence unsupported',{exact:true})).toBeVisible();
      await expect(page.getByText('Desktop shell at backend startup 0.1.28 · build 10',{exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:'Update and restart',exact:true})).toHaveCount(0);
      const action=page.getByRole('link',{name:'Safely switch to this desktop launcher…',exact:true});
      if(build===13){await expect(page.getByText('Current desktop window 0.1.39 · build 13',{exact:true})).toBeVisible();await expect(action).toHaveAttribute('href','pi-desktop://launcher-handoff');}
      else {await expect(action).toHaveCount(0);await expect(page.getByText(/reinstalling build 12 will not help/)).toBeVisible();}
      supported=false;await page.getByRole('button',{name:'Check for updates',exact:true}).click();
      await expect(page.getByText(/first update its business package on Stable/)).toBeVisible();
      if(build===13)await expect(page.getByRole('link',{name:'Get a desktop release with safe handoff',exact:true})).toHaveCount(0);
      supported=true;handedOff=true;await page.getByRole('button',{name:'Check for updates',exact:true}).click();
      await expect(page.getByRole('button',{name:'Update and restart',exact:true})).toBeEnabled();
      await expect(action).toHaveCount(0);
    } finally{await page.close();await bridge.close();}
  });
});
