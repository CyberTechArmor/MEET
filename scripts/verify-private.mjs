import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Do not pass operator credentials, service endpoints or production flags to tests.
const environment=Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','LANG','LC_ALL','TZ'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
environment.NODE_ENV='test';
const steps=[
 ['api/node_modules/typescript/bin/tsc','-p','api/tsconfig.json'],
 ['node_modules/vitest/vitest.mjs','run','--config','vitest.private.config.mjs','--configLoader','runner'],
 ['--test','api/tests/meeting-access.test.cjs','api/tests/meeting-http.test.cjs','api/tests/nodus-upgrade.test.cjs','tests/nodus-private.test.mjs','tests/nodus-private-protocol.test.mjs'],
];
for(const args of steps){
 const result=spawnSync(process.execPath,args,{cwd:root,env:environment,stdio:'inherit',timeout:180000});
 if(result.error||result.signal||result.status!==0)process.exit(result.status||1);
}
