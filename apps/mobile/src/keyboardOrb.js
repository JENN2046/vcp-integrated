// The keyboard owns the draft. Read only the visible DOM change, including IME
// replacements; a browser edit event cannot identify the keyboard microphone.
export function changedInputText(before,after,inputType){
 if(before===after||/^(insertFrom(?:Paste|Drop|Yank)|history)/u.test(inputType||''))return null;
 const oldChars=Array.from(before),newChars=Array.from(after);
 let start=0,oldEnd=oldChars.length,newEnd=newChars.length;
 while(start<oldEnd&&start<newEnd&&oldChars[start]===newChars[start])start++;
 while(oldEnd>start&&newEnd>start&&oldChars[oldEnd-1]===newChars[newEnd-1]){oldEnd--;newEnd--;}
 return newChars.slice(start,newEnd).join('');
}
