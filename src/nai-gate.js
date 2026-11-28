export function createNaiGate({sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>Date.now(),notice=()=>{},gap=1500}={}) {
 let queue=Promise.resolve(),next=0,stopped=false;
 return {stop(){stopped=true;},run(fn){const job=queue.then(async()=>{
  for(let attempt=0;;attempt++){
   if(stopped)throw new Error('生图已停止');
   const delay=next-now();if(delay>0)await sleep(delay);
   if(stopped)throw new Error('生图已停止');
   try{return await fn();}
   catch(e){if((e.status!==429&&!e.retryable)||attempt>=2)throw e;
    const seconds=Number(e.retryAfter),date=Date.parse(e.retryAfter);
    const retry=Number.isFinite(seconds)&&seconds>0?seconds*1000:Number.isFinite(date)?Math.max(0,date-now()):0;
    next=now()+Math.max(retry,5000*2**attempt);
    const wait=Math.ceil((next-now())/1000);
    notice((e.status===429?'请求受到限流':e.status?'NovelAI 服务器返回 '+e.status:'只收到生成中的预览图')+'，等待 '+wait+' 秒后重试');
   }finally{next=Math.max(next,now()+gap);}
  }
 });queue=job.catch(()=>{});return job;}};
}
