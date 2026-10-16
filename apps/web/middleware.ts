import {NextRequest,NextResponse} from 'next/server';
export async function middleware(request:NextRequest){
 try{
  const response=await fetch('http://127.0.0.1:8787/api/session',{headers:{authorization:request.headers.get('authorization')||''},cache:'no-store'});
  if(response.ok)return NextResponse.next();
  return new NextResponse(response.status===401?'TeamForge: sign in with your local account.':'TeamForge: access denied.',{status:response.status,headers:response.status===401?{'WWW-Authenticate':'Basic realm="TeamForge", charset="UTF-8"'}:{}});
 }catch{return new NextResponse('TeamForge API unavailable. Start the API and retry.',{status:503});}
}
export const config={matcher:['/((?!api|_next/static|_next/image|favicon.ico).*)']};
