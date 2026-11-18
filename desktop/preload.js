const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("villifeDesktop", {
  platform: process.platform,
  version: process.env.VILLIFE_VERSION || ""
});
