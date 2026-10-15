/**
 * 우리끼리 골프챌린지 외부 공급용 서버 v1.1.2
 * 기존 경오마스터즈와 완전히 별도인 앱스 스크립트 프로젝트에만 설치하십시오.
 * 기존 3단계에 생성된 팔성마스터즈 스냅샷과 폴더 ID는 보존합니다.
 *
 * 필수 스크립트 속성:
 *   GOLF_SUPPLY_ROOT_FOLDER_ID = 우리끼리골프챌린지_공급본_데이터 폴더 ID
 *
 * 설치 순서:
 *  1. 이 Code.gs로 기존 '공급용 서버' 프로젝트의 코드를 교체하여 저장.
 *  2. golfSupplyStatus 실행하여 팔성마스터즈 자료 확인.
 *  3. 기존 회원 읽기 키를 그대로 사용합니다. 이미 발급했다면 재발급하지 않습니다.
 *  4. 스크립트 속성 GOLF_SUPPLY_PALSEONG_INITIAL_PASSWORD에 최초 경기위원장 암호를 일시 등록한 뒤
 *     golfSupplyInitializePalseongHostPassword()를 수동 실행합니다. 성공 시 평문 속성을 자동 삭제합니다.
 *  5. 기존 웹앱의 배포 관리에서 새 버전으로 업데이트합니다. 새 URL 배포는 하지 않습니다.
 *  6. 공급본 index.html을 GitHub에 교체합니다.
 *
 * 향후 다른 모임 추가:
 *  스크립트 속성 GOLF_SUPPLY_NEW_CLUB_ID, GOLF_SUPPLY_NEW_CLUB_NAME 지정하고
 *  golfSupplyAdminAddClub() 실행(관리자 수동 승인). 새로운 저장폴더/빈 기록/접근키 생성.
 *
 * 보안: 기존 쓰기 키는 저장 권한을 잃습니다. 경기위원장 암호 검증 후
 *       발급한 유효기간 12시간의 서명 세션만 기록을 수정할 수 있습니다.
 *       비밀번호는 원문으로 보존하지 않으며 서버 전용 HMAC 검증정보로 보관합니다.
 *       읽기 접근키 없이는 경기위원장 인증도 사용할 수 없습니다.
 *       사용자가 많은 서비스에는 별도 인증/감사 시스템이 필요합니다.
 *       배포 URL이나 회원용 초대키를 인터넷에 공개하지 마십시오.
 *       Apps Script HtmlService의 iframe 응답은 요청마다 nonce와 브라우저 origin을 확인합니다.
 */
var GS_ROOT_PROP='GOLF_SUPPLY_ROOT_FOLDER_ID';
var GS_ROOT_NAME='우리끼리골프챌린지_공급본_데이터';
var GS_MAX_BYTES=1024*1024;
var GS_SLUG_RE=/^[a-z][a-z0-9-]{2,59}$/;
var GS_SESSION_TTL_MS=12*60*60*1000;
var GS_PASSWORD_FAIL_LIMIT=6;
var GS_PASSWORD_BLOCK_MS=60*1000;

function gsProps_(){return PropertiesService.getScriptProperties()}
function gsClubPrefix_(id){if(!GS_SLUG_RE.test(id))throw Error('모임 식별번호 오류');return 'GOLF_SUPPLY_CLUB_'+id.toUpperCase().replace(/-/g,'_')+'_'}
function gsAuthPrefix_(id){return 'GOLF_SUPPLY_'+id.toUpperCase().replace(/-/g,'_')+'_'}
function gsRoot_(){
 var id=(gsProps_().getProperty(GS_ROOT_PROP)||'').trim();
 if(!id)throw Error('스크립트 속성 '+GS_ROOT_PROP+'가 없습니다.');
 var folder=DriveApp.getFolderById(id);
 if(folder.getName()!==GS_ROOT_NAME)throw Error('공급본 상위 폴더의 이름이 다릅니다: '+folder.getName());
 return folder;
}
function gsChild_(folder,rootId){var it=folder.getParents();while(it.hasNext())if(it.next().getId()===rootId)return true;return false}
function gsMeta_(id){
 var p=gsProps_(),pre=gsClubPrefix_(id);
 var name=(p.getProperty(pre+'NAME')||'').trim();
 // 2~3단계에서 만든 팔성마스터즈 폴더의 기존 식별자를 그대로 이용합니다.
 if(id==='palseong-masters'&&!name)name='팔성마스터즈';
 var folderId=(p.getProperty(pre+'FOLDER_ID')||'').trim();
 if(!name||!folderId)throw Error('등록된 모임이 아닙니다.');
 var root=gsRoot_(),folder=DriveApp.getFolderById(folderId);
 // 표시 이름은 변경될 수 있으므로 데이터 폴더 이름과 비교하지 않습니다.
 // 고정된 모임 ID의 폴더 ID 및 공급본 상위 폴더에 직접 속하는지만 검사합니다.
 if(!gsChild_(folder,root.getId()))throw Error('모임 데이터 폴더의 위치가 일치하지 않습니다.');
 return {id:id,name:name,folder:folder};
}
function gsFiles_(folder){
 var it=folder.getFiles(),out=[];
 while(it.hasNext()){var f=it.next(),name=f.getName();if(/^wgk-\d{8}\.json$/.test(name))out.push({file:f,name:name})}
 out.sort(function(a,b){return a.name<b.name?1:a.name>b.name?-1:0});return out;
}
function gsNameValid_(name){
 return typeof name==='string'&&name.length>=2&&name.length<=60&&
  name.trim()===name&&!/[\x00-\x1f\x7f<>]/.test(name);
}
// 이전 공급본이 허용했던 짧은 모임명도 과거 기록으로 읽을 수 있게 유지합니다.
function gsRecordNameValid_(name){return typeof name==='string'&&name.length>0&&name.length<=60}
function gsRead_(entry,meta){
 var s=entry.file.getBlob().getDataAsString('UTF-8'),o=JSON.parse(s);
 // 과거 스냅샷에는 당시의 모임명이 남아 있을 수 있습니다.
 // 자료 소속 판정은 모임 식별번호 및 폴더 ID로 하며 이름은 표시값으로만 검증합니다.
 if(!o||o.schemaVersion!==4||!o.room||o.room.clubId!==meta.id||!gsRecordNameValid_(o.room.name)||
  typeof o.room.id!=='string'||!o.room.id||!Array.isArray(o.members)||!Array.isArray(o.rounds))
   throw Error('다른 모임 자료 또는 잘못된 데이터 형식: '+entry.name);
 return o;
}
function gsEmpty_(meta){
 var now=new Date().toISOString();return {schemaVersion:4,
  room:{id:Utilities.getUuid(),clubId:meta.id,name:meta.name,createdAt:now},
  members:[],rounds:[],hcpWindow:5,updatedAt:now};
}
function gsCreateInitial_(meta){
 var files=gsFiles_(meta.folder);
 if(files.length){gsRead_(files[0],meta);return {created:false,name:files[0].name}}
 if(meta.folder.getFiles().hasNext())throw Error('알 수 없는 파일이 있어 초기화를 중단합니다.');
 var n='wgk-00000001.json';
 meta.folder.createFile(Utilities.newBlob(JSON.stringify(gsEmpty_(meta)),'application/json',n));
 return {created:true,name:n};
}
function gsDigest_(key){
 if(typeof key!=='string'||!/^wgk_[a-f0-9]{128}$/.test(key))return '';
 return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,key,Utilities.Charset.UTF_8)
  .map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2)}).join('');
}
function gsEq_(a,b){
 if(typeof a!=='string'||typeof b!=='string'||a.length!==64||b.length!==64)return false;
 var d=0;for(var i=0;i<64;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;
}
function gsKey_(){return 'wgk_'+[0,1,2,3].map(function(){return Utilities.getUuid().replace(/-/g,'')}).join('')}
function gsHex_(bytes){return bytes.map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2)}).join('')}
function gsRandom_(){return [0,1,2,3].map(function(){return Utilities.getUuid().replace(/-/g,'')}).join('')}
function gsHmac_(secret,message){return gsHex_(Utilities.computeHmacSha256Signature(message,secret))}
function gsPasswordValid_(pw){return typeof pw==='string'&&pw.length>=10&&pw.length<=72&&pw.trim()===pw}
function gsPasswordProof_(pw,salt,secret){return gsHmac_(secret,salt+':'+pw)}
function gsReady_(id){
 var p=gsProps_(),pre=gsAuthPrefix_(id);
 return p.getProperty(pre+'ACCESS_READY')==='1'&&
  /^[a-f0-9]{64}$/.test(p.getProperty(pre+'READ_SHA256')||'');
}
/** 이전 쓰기 키는 더 이상 어떤 작업의 권한도 부여하지 않습니다. */
function gsMemberPermission_(id,key){
 if(!gsReady_(id))throw Error('회원용 접근키를 발급하지 않은 모임입니다.');
 var h=gsDigest_(key),p=gsProps_(),pre=gsAuthPrefix_(id);
 if(!gsEq_(h,p.getProperty(pre+'READ_SHA256')))throw Error('회원용 접근키가 맞지 않습니다.');
}
/** 읽기 키는 서버 속성에 원문을 저장하지 않으며, 신규 모임에만 발급합니다. */
function gsProvision_(id){
 var p=gsProps_(),pre=gsAuthPrefix_(id);
 if(['READ_SHA256','ACCESS_READY'].some(function(k){return !!p.getProperty(pre+k)}))
  throw Error('회원용 접근키가 이미 존재합니다. 중복 생성하지 않았습니다.');
 var meta=gsMeta_(id),snap=gsFiles_(meta.folder);
 if(!snap.length)throw Error('먼저 모임 초기 스냅샷을 생성하세요.');
 gsRead_(snap[0],meta);
 var read=gsKey_();
 p.setProperties({[pre+'READ_SHA256']:gsDigest_(read),[pre+'ACCESS_READY']:'1'},false);
 Logger.log('회원용 읽기 키 (기존 모임은 재발급 금지): '+read);
 Logger.log('새 경기위원장 인증은 암호만 사용합니다.');
 return {ok:true,clubId:id,created:true,message:'모임 회원용 읽기 키 발급 완료'};
}
/** 관리자 전용: 새 모임에 초기 암호를 수동 등록. 기존 암호가 있으면 절대 덮어쓰지 않습니다. */
function gsInitializeHostPassword_(id,initialProperty){
 var lock=LockService.getScriptLock();lock.waitLock(30000);
 try{
  var meta=gsMeta_(id),p=gsProps_(),pre=gsAuthPrefix_(id);
  if(!gsReady_(id))throw Error('먼저 회원용 읽기 키를 발급하세요.');
  if(p.getProperty(pre+'HOST_PASSWORD_MAC'))throw Error('이미 경기위원장 암호가 설정되었습니다. 초기화하지 않았습니다.');
  var pw=p.getProperty(initialProperty)||'';
  if(!gsPasswordValid_(pw))throw Error('초기 암호는 공백 없는 10~72글자여야 합니다.');
  var salt=gsRandom_(),secret=gsRandom_(),sessionKey=gsRandom_();
  var obj={};obj[pre+'HOST_PASSWORD_SALT']=salt;
  obj[pre+'HOST_PASSWORD_PEPPER']=secret;
  obj[pre+'HOST_PASSWORD_MAC']=gsPasswordProof_(pw,salt,secret);
  obj[pre+'HOST_SESSION_KEY']=sessionKey;
  obj[pre+'HOST_AUTH_REVB']='1';
  p.setProperties(obj,false);
  p.deleteProperty(initialProperty);
  // 기존에 발급된 쓰기 키의 해시도 폐기합니다. 기존 키로는 더 이상 쓰기가 불가합니다.
  p.deleteProperty(pre+'WRITE_SHA256');
  var result={ok:true,clubId:id,clubName:meta.name,passwordReady:true,
   message:'경기위원장 암호 등록 완료. 기존 쓰기 키는 폐기되었으며 기존 회원과 경기기록은 유지됩니다.'};
  Logger.log(JSON.stringify(result));return result;
 }finally{lock.releaseLock()}
}
function golfSupplyInitializePalseongHostPassword(){
 return gsInitializeHostPassword_('palseong-masters','GOLF_SUPPLY_PALSEONG_INITIAL_PASSWORD');
}
/** 다른 모임의 최초 암호는 운영자만 스크립트 속성을 통해 설정할 수 있습니다. */
function golfSupplyInitializeNewClubHostPassword(){
 var id=(gsProps_().getProperty('GOLF_SUPPLY_NEW_CLUB_ID')||'').trim();
 return gsInitializeHostPassword_(id,'GOLF_SUPPLY_NEW_CLUB_INITIAL_PASSWORD');
}
/** 공급자만 직접 실행하는 복구: 비밀번호 분실 시 다른 정보는 그대로 두고 암호와 모든 세션만 바꿉니다. */
function golfSupplyAdminResetPalseongHostPassword(){
 var id='palseong-masters',p=gsProps_(),newPw=p.getProperty('GOLF_SUPPLY_PALSEONG_RESET_PASSWORD')||'';
 if(p.getProperty('GOLF_SUPPLY_PALSEONG_RESET_CONFIRM')!=='RESET-palseong-masters')
  throw Error('관리자 확인 속성 GOLF_SUPPLY_PALSEONG_RESET_CONFIRM을 설정하십시오.');
 if(!gsPasswordValid_(newPw))throw Error('재설정 암호는 공백 없는 10~72글자여야 합니다.');
 var lock=LockService.getScriptLock();lock.waitLock(30000);
 try{
  var meta=gsMeta_(id),pre=gsAuthPrefix_(id);
  if(!gsHostReady_(id))throw Error('초기 암호가 설정되지 않았습니다.');
  var salt=gsRandom_(),pepper=gsRandom_(),sessionKey=gsRandom_();
  var changed={};changed[pre+'HOST_PASSWORD_SALT']=salt;
  changed[pre+'HOST_PASSWORD_PEPPER']=pepper;
  changed[pre+'HOST_PASSWORD_MAC']=gsPasswordProof_(newPw,salt,pepper);
  changed[pre+'HOST_SESSION_KEY']=sessionKey;
  p.setProperties(changed,false);
  p.deleteProperty('GOLF_SUPPLY_PALSEONG_RESET_PASSWORD');
  p.deleteProperty('GOLF_SUPPLY_PALSEONG_RESET_CONFIRM');
  Logger.log('팔성마스터즈 경기위원장 암호 재설정 완료. 기존 세션은 모두 무효화되었습니다. 기록은 보존했습니다.');
  return {ok:true,clubId:meta.id,reset:true};
 }finally{lock.releaseLock()}
}
function gsHostReady_(id){
 var p=gsProps_(),pre=gsAuthPrefix_(id);
 return gsReady_(id)&&/^[a-f0-9]{64}$/.test(p.getProperty(pre+'HOST_PASSWORD_MAC')||'')&&
 !!p.getProperty(pre+'HOST_PASSWORD_SALT')&&!!p.getProperty(pre+'HOST_PASSWORD_PEPPER')&&
 !!p.getProperty(pre+'HOST_SESSION_KEY');
}
function gsVerifyHostPassword_(id,pw){
 if(!gsHostReady_(id)||typeof pw!=='string'||pw.length>72)return false;
 var p=gsProps_(),pre=gsAuthPrefix_(id);
 return gsEq_(gsPasswordProof_(pw,p.getProperty(pre+'HOST_PASSWORD_SALT'),
  p.getProperty(pre+'HOST_PASSWORD_PEPPER')),p.getProperty(pre+'HOST_PASSWORD_MAC'));
}
function gsSessionSign_(id){
 var p=gsProps_(),pre=gsAuthPrefix_(id),expires=Date.now()+GS_SESSION_TTL_MS;
 var body=[id,String(expires),gsRandom_()].join('.');
 var sig=gsHmac_(p.getProperty(pre+'HOST_SESSION_KEY'),body);
 return {token:'gs1.'+body+'.'+sig,expiresAt:new Date(expires).toISOString()};
}
function gsSessionCheck_(id,token){
 if(!gsHostReady_(id)||typeof token!=='string')return false;
 var x=token.match(/^gs1\.([a-z][a-z0-9-]{2,59})\.(\d{13})\.([a-f0-9]{128})\.([a-f0-9]{64})$/);
 if(!x||x[1]!==id||Number(x[2])<Date.now())return false;
 var p=gsProps_(),pre=gsAuthPrefix_(id),body=[x[1],x[2],x[3]].join('.');
 return gsEq_(gsHmac_(p.getProperty(pre+'HOST_SESSION_KEY'),body),x[4]);
}
/** 비밀번호 검증은 일시적으로 모임 단위 시도 제한을 적용합니다. */
function gsPasswordCheckLimited_(id,pw){
 var p=gsProps_(),pre=gsAuthPrefix_(id),now=Date.now();
 var until=Number(p.getProperty(pre+'HOST_LOCK_UNTIL')||0);
 if(until>now)throw Error('암호 입력이 잠시 제한되었습니다. 1분 뒤 다시 시도하십시오.');
 if(gsVerifyHostPassword_(id,pw)){
  p.deleteProperty(pre+'HOST_FAIL_COUNT');p.deleteProperty(pre+'HOST_LOCK_UNTIL');return true;
 }
 var attempts=Number(p.getProperty(pre+'HOST_FAIL_COUNT')||0)+1;
 if(attempts>=GS_PASSWORD_FAIL_LIMIT){
  p.setProperties({[pre+'HOST_FAIL_COUNT']:'0',[pre+'HOST_LOCK_UNTIL']:String(now+GS_PASSWORD_BLOCK_MS)},false);
 }else p.setProperty(pre+'HOST_FAIL_COUNT',String(attempts));
 throw Error('경기위원장 암호가 일치하지 않습니다.');
}
/** 이미 준비된 팔성마스터즈만 초기 인증키를 한 번 발급합니다. */
function golfSupplyProvisionPalseongAccess(){
 var lock=LockService.getScriptLock();lock.waitLock(30000);
 try{return gsProvision_('palseong-masters')}finally{lock.releaseLock()}
}
/** 관리자가 모임을 추가할 경우 스크립트 속성의 새 모임 ID/이름을 확인합니다. */
function golfSupplyAdminAddClub(){
 var p=gsProps_(),id=(p.getProperty('GOLF_SUPPLY_NEW_CLUB_ID')||'').trim();
 var name=(p.getProperty('GOLF_SUPPLY_NEW_CLUB_NAME')||'').trim();
 if(!GS_SLUG_RE.test(id)||!name||name.length>60)throw Error('GOLF_SUPPLY_NEW_CLUB_ID/NAME 속성을 먼저 설정하십시오.');
 var lock=LockService.getScriptLock();lock.waitLock(30000);
 try{
  var root=gsRoot_(),pre=gsClubPrefix_(id),folderId=(p.getProperty(pre+'FOLDER_ID')||'').trim();
  if(!folderId){
   var found=root.getFoldersByName(name);
   if(found.hasNext())throw Error('동일 이름의 폴더가 있으므로 임의 연결하지 않습니다.');
   // 최초 등록은 폴더를 먼저 만든 후 속성에 기록합니다.
   var folder=root.createFolder(name);
   p.setProperty(pre+'FOLDER_ID',folder.getId());
  }
  if(!p.getProperty(pre+'NAME'))p.setProperty(pre+'NAME',name);
  var meta=gsMeta_(id);
  if(meta.name!==name&&!gsReady_(id))throw Error('기존 모임 이름이 다릅니다. 등록정보를 확인하십시오.');
  var snap=gsCreateInitial_(meta);
  if(gsReady_(id)){
   var old={ok:true,created:false,clubId:id,version:snap.name,message:'기존 모임입니다. 중복 생성하지 않았습니다.'};
   Logger.log(JSON.stringify(old));return old;
  }
  return gsProvision_(id);
 }finally{lock.releaseLock()}
}
/** 드라이브의 데이터를 변경하지 않는 관리자 점검 함수. */
function golfSupplyStatus(){
 var meta=gsMeta_('palseong-masters'),files=gsFiles_(meta.folder);
 if(!files.length)throw Error('팔성마스터즈 초기 기록이 없습니다.');
 var d=gsRead_(files[0],meta),out={ok:true,clubId:meta.id,clubName:meta.name,
  accessReady:gsReady_(meta.id),hostPasswordReady:gsHostReady_(meta.id),latestVersion:files[0].name,
  members:d.members.length,rounds:d.rounds.length};
 Logger.log(JSON.stringify(out,null,2));return out;
}
function gsRpc_(req){
 if(!req||typeof req!=='object'||Array.isArray(req)||!GS_SLUG_RE.test(req.clubId||''))
  throw Error('잘못된 요청입니다.');
 var meta=gsMeta_(req.clubId);
 gsMemberPermission_(meta.id,req.token); // 모든 작업에 회원용 조회 키가 필요합니다.
 var files=gsFiles_(meta.folder);
 if(!files.length)throw Error('기록을 초기화하지 않은 모임입니다.');
 var last=files[0],data=gsRead_(last,meta);
 if(req.action==='hostAuth'){
  var authLock=LockService.getScriptLock();authLock.waitLock(30000);
  try{
   gsPasswordCheckLimited_(meta.id,req.password);
   var signed=gsSessionSign_(meta.id);
   return {ok:true,clubId:meta.id,role:'host',session:signed.token,expiresAt:signed.expiresAt};
  }finally{authLock.releaseLock()}
 }
 if(req.action==='status')return {ok:true,clubId:meta.id,clubName:meta.name,version:last.name,
  hostPasswordReady:gsHostReady_(meta.id)};
 if(req.action==='latest')return {ok:true,clubId:meta.id,name:last.name,version:last.name,data:JSON.stringify(data)};
 if(req.action==='changeHostPassword'){
  if(!gsSessionCheck_(meta.id,req.hostSession))throw Error('경기위원장 인증이 만료되었습니다. 다시 암호를 입력하십시오.');
  if(!gsPasswordValid_(req.newPassword))throw Error('새 암호는 공백 없는 10~72글자여야 합니다.');
  var pwLock=LockService.getScriptLock();pwLock.waitLock(30000);
  try{
   if(!gsSessionCheck_(meta.id,req.hostSession))throw Error('경기위원장 인증이 변경되었습니다.');
   gsPasswordCheckLimited_(meta.id,req.currentPassword);
   if(req.currentPassword===req.newPassword)throw Error('현재와 다른 새 암호를 입력하십시오.');
   var p=gsProps_(),pre=gsAuthPrefix_(meta.id),salt=gsRandom_();
   // 세션 서명 키를 교체하면 모든 기존 기기의 세션이 서버에서 무효화됩니다.
   p.setProperties({[pre+'HOST_PASSWORD_SALT']:salt,
    [pre+'HOST_PASSWORD_MAC']:gsPasswordProof_(req.newPassword,salt,p.getProperty(pre+'HOST_PASSWORD_PEPPER')),
    [pre+'HOST_SESSION_KEY']:gsRandom_()},false);
   var nextSession=gsSessionSign_(meta.id);
   return {ok:true,changed:true,session:nextSession.token,expiresAt:nextSession.expiresAt};
  }finally{pwLock.releaseLock()}
 }
 if(req.action==='renameClub'){
  if(!gsSessionCheck_(meta.id,req.hostSession))throw Error('경기위원장 인증이 만료되었습니다. 다시 암호를 입력하십시오.');
  var newName=req.newName;
  if(!gsNameValid_(newName))throw Error('모임 이름은 앞뒤 공백 없는 2~60글자로 입력하십시오.');
  if(typeof req.baseVersion!=='string'||!/^wgk-\d{8}\.json$/.test(req.baseVersion))
   throw Error('저장 기준이 없습니다. 최신 기록을 먼저 받아야 합니다.');
  var renameLock=LockService.getScriptLock();renameLock.waitLock(30000);
  try{
   if(!gsSessionCheck_(meta.id,req.hostSession))throw Error('경기위원장 인증이 변경되었습니다. 다시 인증하십시오.');
   var current=gsFiles_(meta.folder);
   if(!current.length)throw Error('기준 스냅샷이 없습니다.');
   if(current[0].name!==req.baseVersion)return {ok:false,conflict:true,latestVersion:current[0].name,
    error:'다른 기기가 최신 기록을 올렸습니다. 최신 기록을 받은 뒤 이름을 바꾸십시오.'};
   var saved=gsRead_(current[0],meta);
   if(newName===meta.name)return {ok:true,unchanged:true,clubId:meta.id,clubName:meta.name,version:current[0].name};
   var num=Number(current[0].name.slice(4,12))+1;
   if(num>99999999||!Number.isSafeInteger(num))throw Error('스냅샷 기록번호가 가득 찼습니다.');
   var next='wgk-'+('00000000'+num).slice(-8)+'.json';
   if(meta.folder.getFilesByName(next).hasNext())throw Error('동일 파일명 충돌');
   var updated=JSON.parse(JSON.stringify(saved));
   updated.room.name=newName;updated.updatedAt=new Date().toISOString();
   var props=gsProps_(),key=gsClubPrefix_(meta.id)+'NAME',before=props.getProperty(key);
   // 잠금 범위에서 표시 이름을 갱신하고 변경된 이름의 새 스냅샷을 기록합니다.
   // 새 파일 생성 실패 시 이전 표시 이름으로 복원합니다. 기존 스냅샷은 수정하지 않습니다.
   props.setProperty(key,newName);
   try{
    meta.folder.createFile(Utilities.newBlob(JSON.stringify(updated),'application/json',next));
   }catch(writeErr){
    try{if(before===null)props.deleteProperty(key);else props.setProperty(key,before)}catch(restoreErr){
     Logger.log('모임 이름 저장 롤백 실패: '+String(restoreErr));
    }
    throw writeErr;
   }
   return {ok:true,changed:true,clubId:meta.id,clubName:newName,version:next,updatedAt:updated.updatedAt};
  }finally{renameLock.releaseLock()}
 }
 if(req.action==='publish'){
  if(!gsSessionCheck_(meta.id,req.hostSession))throw Error('경기위원장 인증이 만료되었습니다. 다시 암호를 입력하십시오.');
  if(typeof req.baseVersion!=='string'||!/^wgk-\d{8}\.json$/.test(req.baseVersion))
   throw Error('저장 기준이 없습니다. 최신 기록을 먼저 받아야 합니다.');
  if(typeof req.data!=='string'||Utilities.newBlob(req.data).getBytes().length>GS_MAX_BYTES)
   throw Error('기록 용량 한도(1MiB)를 초과했습니다.');
  var incoming=JSON.parse(req.data);
  if(!incoming||incoming.schemaVersion!==4||!incoming.room||
   incoming.room.id!==data.room.id||incoming.room.clubId!==meta.id||!gsRecordNameValid_(incoming.room.name)||
   !Array.isArray(incoming.members)||!Array.isArray(incoming.rounds)||
   incoming.members.length>1000||incoming.rounds.length>10000)
    throw Error('다른 모임 기록이거나 허용되지 않는 형식입니다.');
  // 다른 기기의 동시 등록 및 수정으로 최신 버전이 바뀌지 않았는지 잠금 안에서 재확인합니다.
  var lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
   var current=gsFiles_(meta.folder);
   if(!current.length)throw Error('기준 스냅샷이 없습니다.');
   // 비밀번호 변경과 저장은 같은 스크립트 잠금을 사용하므로 변경된 세션을 재검사합니다.
   if(!gsSessionCheck_(meta.id,req.hostSession))throw Error('경기위원장 인증이 변경되었습니다. 다시 인증하십시오.');
   var safe=gsRead_(current[0],meta);
   if(safe.room.id!==incoming.room.id)throw Error('모임 고유 번호가 바뀌었습니다.');
   if(current[0].name!==req.baseVersion)return {ok:false,conflict:true,latestVersion:current[0].name,
    error:'다른 기기가 최신 기록을 올렸습니다. 이 기기의 기록을 먼저 백업하고 확인하십시오.'};
   // 이름 변경 전에 만든 백업도 같은 모임 ID라면 복원할 수 있지만
   // 서버에 보존된 현재 표시 이름을 우선합니다.
   incoming.room.name=meta.name;
   var seq=Number(current[0].name.slice(4,12))+1;
   if(seq>99999999||!Number.isSafeInteger(seq))throw Error('스냅샷 기록번호가 가득 찼습니다.');
   var next='wgk-'+('00000000'+seq).slice(-8)+'.json';
   if(meta.folder.getFilesByName(next).hasNext())throw Error('동일 파일명 충돌');
   incoming.updatedAt=new Date().toISOString();
   meta.folder.createFile(Utilities.newBlob(JSON.stringify(incoming),'application/json',next));
   return {ok:true,clubId:meta.id,name:next,version:next,updatedAt:incoming.updatedAt};
  }finally{lock.releaseLock()}
 }
 throw Error('허용되지 않은 기능입니다.');
}
/** 직접 GET 요청으로는 개인정보를 반환하지 않습니다. */
function doGet(e){
 return ContentService.createTextOutput(JSON.stringify({ok:true,name:'Golf Challenge Supply Server v1.1.2',
  message:'기록 송수신은 인증된 POST 요청만 허용됩니다.'})).setMimeType(ContentService.MimeType.JSON);
}
/** GitHub Pages ↔ Apps Script의 CORS 문제를 피하는 HTML 폼 응답 통신. */
function doPost(e){
 var rid='',origin='*',result;
 try{
  rid=(e&&e.parameter&&e.parameter.rid)||'';
  origin=(e&&e.parameter&&e.parameter.origin)||'*';
  if(!/^wgk[a-f0-9]{32}$/.test(rid))throw Error('요청 식별번호 형식 오류');
  if(!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(origin))origin='*';
  var raw=e&&e.parameter&&e.parameter.payload;
  if(typeof raw!=='string'||raw.length>GS_MAX_BYTES*2)throw Error('요청 크기 오류');
  result=gsRpc_(JSON.parse(raw));
 }catch(err){
  Logger.log('공급 서버 요청 처리 실패: '+String(err&&err.message||err));
  // 진단에 필요한 보안 관련 오류만 식별하여 응답하며 비밀키나 암호는 출력하지 않습니다.
  var why=String(err&&err.message||'');
  var safeMessages=['경기위원장 인증이 만료되었습니다. 다시 암호를 입력하십시오.',
   '경기위원장 인증이 변경되었습니다. 다시 인증하십시오.',
   '암호 입력이 잠시 제한되었습니다. 1분 뒤 다시 시도하십시오.',
   '경기위원장 암호가 일치하지 않습니다.',
   '새 암호는 공백 없는 10~72글자여야 합니다.',
   '현재와 다른 새 암호를 입력하십시오.',
   '모임 이름은 앞뒤 공백 없는 2~60글자로 입력하십시오.'];
  result={ok:false,error:safeMessages.indexOf(why)>=0?why:'요청을 처리할 수 없습니다. 모임, 인증 및 기록의 최신 상태를 확인하십시오.'};
 }
 // JSON을 HTML/JS 문맥에 삽입할 때 태그 종결, JS 줄바꿈 문자를 이스케이프합니다.
 var msg=JSON.stringify({__wgkSupplyRpc:true,rid:rid,response:result})
  .replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 var target=JSON.stringify(origin);
 var page='<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><script>'+
  'window.top.postMessage('+msg+','+target+');'+
  '</scr'+'ipt></body></html>';
 return HtmlService.createHtmlOutput(page).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 비밀번호 재설정 실패 원인 점검 (운영 정보 읽기 전용).
 * 비밀번호 자체, 접근키, 속성값은 로그나 반환값에 포함하지 않습니다.
 * Apps Script 함수 선택: golfSupplyDiagnosePassword > 실행
 * 원인을 확인한 뒤에도 이 함수를 남겨두어도 기록 수정은 하지 않습니다.
 */
function golfSupplyDiagnosePassword() {
  var props = PropertiesService.getScriptProperties();
  var key = 'GOLF_SUPPLY_PALSEONG_RESET_PASSWORD';
  var value = props.getProperty(key);
  var result = {
    propertyExists: value !== null,
    length: value === null ? null : value.length,
    noOuterSpaces: value === null ? null : value.trim() === value,
    actualValidation: gsPasswordValid_(value),
    tenCharacterTest: gsPasswordValid_('0123456789')
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
