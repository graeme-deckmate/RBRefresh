const fs = require('fs');
const content = fs.readFileSync('RBEXP.tsx', 'utf8');
const lines = content.split('\n');

const parenStack = [];
const braceStack = [];
const bracketStack = [];

let inString = false;
let stringChar = '';
let inComment = false;
let inRegex = false;
let regexInBrackets = false;

function isEscaped(line, pos) {
    let count = 0;
    let i = pos - 1;
    while (i >= 0 && line[i] === '\\') {
        count++;
        i--;
    }
    return count % 2 !== 0;
}

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    inRegex = false;

    for (let j = 0; j < line.length; j++) {
        const char = line[j];
        const prev = line[j - 1];
        const next = line[j + 1];

        if (inComment) {
            if (char === '/' && prev === '*' && !isEscaped(line, j - 1)) inComment = false;
            continue;
        }
        if (inString) {
            if (char === stringChar && !isEscaped(line, j)) inString = false;
            continue;
        }
        if (inRegex) {
            if (char === '[' && !isEscaped(line, j)) regexInBrackets = true;
            if (char === ']' && !isEscaped(line, j)) regexInBrackets = false;
            if (char === '/' && !isEscaped(line, j) && !regexInBrackets) inRegex = false;
            continue;
        }
        if (char === '/' && next === '/') break;
        if (char === '/' && next === '*') { inComment = true; j++; continue; }
        if (char === '"' || char === "'" || char === '`') { inString = true; stringChar = char; continue; }
        if (char === '/' && !inRegex) {
            const b = line.slice(0, j).trim();
            const lc = b[b.length - 1];
            if (!lc || "(=:!&|?{[;,".includes(lc) || b.endsWith("return") || b.endsWith("case")) { inRegex = true; continue; }
        }

        if (char === '(') parenStack.push({ line: i + 1, col: j + 1 });
        if (char === ')') {
            if (parenStack.length > 0) parenStack.pop();
            else console.log(`Extra ) at L${i + 1}:C${j + 1}`);
        }
        if (char === '{') braceStack.push({ line: i + 1, col: j + 1 });
        if (char === '}') {
            if (braceStack.length > 0) braceStack.pop();
            else console.log(`Extra } at L${i + 1}:C${j + 1}`);
        }
        if (char === '[') bracketStack.push({ line: i + 1, col: j + 1 });
        if (char === ']') {
            if (bracketStack.length > 0) bracketStack.pop();
            else console.log(`Extra ] at L${i + 1}:C${j + 1}`);
        }
    }
    if (inString && stringChar !== '`') inString = false;
}

console.log('Unmatched ( :');
parenStack.forEach(p => console.log(`  L${p.line}:C${p.col}`));
console.log('Unmatched { :');
braceStack.forEach(b => console.log(`  L${b.line}:C${b.col}`));
console.log('Unmatched [ :');
bracketStack.forEach(b => console.log(`  L${b.line}:C${b.col}`));
