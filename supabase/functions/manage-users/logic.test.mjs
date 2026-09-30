// Test de la logique pure de manage-users : node --experimental-strip-types supabase/functions/manage-users/logic.test.mjs
import { parseRequest, checkTarget, checkInvite, siteOrigin, inviteErrorMessage } from './logic.ts'
import assert from 'node:assert/strict'
const U1='00000000-0000-4000-8000-000000000001', U2='00000000-0000-4000-8000-000000000002'
const members=[{workspace_id:'w',user_id:U1,email:'a@x.fr',role:'owner',is_self:true},{workspace_id:'w',user_id:U2,email:'b@x.fr',role:'viewer',is_self:false}]
assert.deepEqual(parseRequest({action:'invite',email:' Bob@Exemple.FR ',role:'viewer'}),{ok:true,value:{action:'invite',email:'bob@exemple.fr',role:'viewer'}})
assert.equal(parseRequest({action:'invite',email:'nope',role:'viewer'}).ok,false)
assert.equal(parseRequest({action:'invite',email:'a@b.fr',role:'admin'}).ok,false)
assert.equal(parseRequest({action:'remove',userId:'x'}).ok,false)
assert.equal(parseRequest({action:'drop'}).ok,false)
assert.equal(parseRequest(null).ok,false)
assert.equal(checkTarget('remove',members,U2).ok,true)
assert.equal(checkTarget('remove',members,U1).ok,false)
assert.equal(checkTarget('reset_mfa',members,U1).ok,false)
assert.equal(checkTarget('reset_mfa',members,U2).ok,true)
assert.equal(checkTarget('remove',members,'00000000-0000-4000-8000-000000000009').status,404)
const two=[{...members[0],is_self:false},{...members[1],role:'owner',is_self:true}]
assert.equal(checkTarget('remove',two,U1).ok,true)
const one=[{...members[0],is_self:false,role:'owner'},{...members[1],is_self:true,role:'owner'}]; one[1].role='viewer'
assert.equal(checkTarget('remove',one,U1).ok,false)
assert.equal(checkInvite(members,'A@x.fr'.toLowerCase()).ok,false)
assert.equal(checkInvite(members,'c@x.fr').ok,true)
assert.equal(siteOrigin('https://yellowscope.netlify.app',undefined),'https://yellowscope.netlify.app')
assert.equal(siteOrigin('http://evil.example',undefined),null)
assert.equal(siteOrigin(null,'https://x.fr/'),'https://x.fr')
assert.equal(siteOrigin('http://localhost:5173',undefined),'http://localhost:5173')
assert.equal(inviteErrorMessage({code:'email_exists'}).status,409)
assert.match(inviteErrorMessage({code:'email_exists'}).error,/Authentication > Users/)
assert.equal(inviteErrorMessage({code:'over_email_send_rate_limit'}).status,429)
assert.match(inviteErrorMessage({message:'boom'}).error,/boom/)
console.log('logic OK')
