// Preloaded (node --import) into every process a test run starts.
//
// `os.userInfo().homedir` comes from the system's account database, not from HOME, so the throwaway HOME that the
// test runner sets does not reach it. Code that asks "who is the account, where is its home" (the auto-update policy
// reads the account's own ~/.memesh/config.json) would read the MAINTAINER's real file from inside a test, however
// well the test isolated everything else. Here that answer follows HOME, in this process and in every node process
// it starts (NODE_OPTIONS is inherited).
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const realUserInfo = os.userInfo;

os.userInfo = (options) => {
  const info = realUserInfo.call(os, options);
  const home = process.env.HOME;
  return home ? { ...info, homedir: home } : info;
};
// `import { userInfo } from 'node:os'` is a live binding to the module's own export, not to the property just replaced: without
// this, code that imports it by name still asks the system.
syncBuiltinESMExports();
