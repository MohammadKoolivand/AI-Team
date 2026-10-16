import crypto from 'node:crypto';
const password=crypto.randomBytes(24).toString('base64url');
export const testAuthEnv={TEAMFORGE_ADMIN_USER:'admin',TEAMFORGE_ADMIN_PASSWORD:password};
const authorization='Basic '+Buffer.from(`admin:${password}`).toString('base64');
export function authenticatedFetch(url,options={}){return fetch(url,{...options,headers:{authorization,...options.headers}});}
