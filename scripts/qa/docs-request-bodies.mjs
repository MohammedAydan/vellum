// Tokenize shell argument text without evaluating variables, substitutions or commands.
// This parser intentionally supports only the quoting used by the docs' curl examples.
export function shellWords(text) {
 const words=[];let word='',quote='',started=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quote==="'"){if(c==="'")quote='';else word+=c;started=true;continue;}
  if(c==='\\'&&quote!=="'") {const next=text[++i];if(next!=='\n')word+=next||'';started=true;continue;}
  if(quote==='"'){if(c==='"')quote='';else word+=c;started=true;continue;}
  if(c==='"'||c==="'"){quote=c;started=true;continue;}
  if(/\s/.test(c)){if(started){words.push(word);word='';started=false;}continue;}
  word+=c;started=true;
 }
 if(quote)throw new Error('Unclosed shell quote');if(started)words.push(word);return words;
}
export function requestBodies(code){
 const words=shellWords(code),result=[];
 for(let i=0;i<words.length;i++)if(['-d','--data','--data-raw','--data-binary'].includes(words[i])){
  const raw=words[++i];if(raw?.startsWith('@'))continue;
  if(raw?.trim().startsWith('{')||raw?.trim().startsWith('['))result.push(JSON.parse(raw));
 }
 return result;
}
