/** Collapse actual file deltas; a create/delete or edit/revert pair is not an implementation. */
export function effectiveChanges(changes=[]){
 const files=new Map();
 for(const change of changes){const prior=files.get(change.path);files.set(change.path,{...change,before:prior?prior.before:change.before});}
 return [...files.values()].filter(change=>change.before!==change.after).map(change=>({...change,type:change.before===null?'added':change.after===null?'deleted':'modified',oldLines:typeof change.before==='string'?change.before.split('\n').length:0,newLines:typeof change.after==='string'?change.after.split('\n').length:0}));
}
export function hasImplementationChanges(changes=[]){
 return effectiveChanges(changes).some(change=>typeof change.path==='string'&&!/(^|\/)(docs?|documentation)\//i.test(change.path)&&!/(\.(md|markdown|txt|rst|adoc)$|(^|\/)(readme|license|notice|changelog)(\.[^/]*)?$)/i.test(change.path));
}
export function stageHasImplementation(stage){return hasImplementationChanges((stage?.revisions||[]).flatMap(revision=>revision.changes||[]));}
