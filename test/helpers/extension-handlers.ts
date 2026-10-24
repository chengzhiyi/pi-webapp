/** SDK-like event fanout: hosted adapter and host both register lifecycle hooks. */
export class ExtensionHandlers {
  private events = new Map<string, Array<(event:any,ctx:any)=>unknown>>();
  set(event:string, handler:(event:any,ctx:any)=>unknown) {
    const list=this.events.get(event)??[];this.events.set(event,list);list.push(handler);
    return ()=>{const index=list.indexOf(handler);if(index>=0)list.splice(index,1);};
  }
  get(event:string) {return async (value:any,ctx:any)=>{for(const handler of [...this.events.get(event)??[]])await handler(value,ctx);};}
}
