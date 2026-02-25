const fs = require('fs');
const content = fs.readFileSync('RBEXP.tsx', 'utf8');
const lines = content.split('\n');

let braceLevel = 0;
let parenLevel = 0;
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
    const oldP = parenLevel;
    inRegex = false;

    for (let j = 0; j < line.length; j++) {
        const char = line[j];
        const prev = line[j - 1];
        const next = line[j + 1];
        if (inComment) { if (char === '/' && prev === '*' && !isEscaped(line, j - 1)) inComment = false; continue; }
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
        if (char === '(') parenLevel++;
        if (char === ')') parenLevel--;
        if (char === '{') braceLevel++;
        if (char === '}') braceLevel--;
    }

    if (parenLevel > oldP) {
        // It increased. Let's see if it stays high.
        // But actually, just logging whenever it changes and stays is good.
    }

    if (i + 1 % 100 === 0) {
        // console.log(i+1, parenLevel);
    }

    if (inString && stringChar !== '`') inString = false;
}

// Third pass: find first persistent P increase
braceLevel = 0; parenLevel = 0; inString = false; inComment = false; inRegex = false;
let lastZeroLine = 0;
for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    inRegex = false;
    for (let j = 0; j < line.length; j++) {
        const char = line[j]; const prev = line[j - 1]; const next = line[j + 1];
        if (inComment) { if (char === '/' && prev === '*' && !isEscaped(line, j - 1)) inComment = false; continue; }
        if (inString) { if (char === stringChar && !isEscaped(line, j)) inString = false; continue; }
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
            const b = line.slice(0, j).trim(); const lc = b[b.length - 1];
            if (!lc || "(=:!&|?{[;,".includes(lc) || b.endsWith("return") || b.endsWith("case")) { inRegex = true; continue; }
        }
        if (char === '(') parenLevel++;
        if (char === ')') parenLevel--;
        if (char === '{') braceLevel++;
        if (char === '}') braceLevel--;
    }
    if (parenLevel === 0) lastZeroLine = i + 1;
    if (i + 1 > lastZeroLine + 20) {
        console.log(`Persistent P increase started at line ${lastZeroLine + 1}: P=${parenLevel} | ${lines[lastZeroLine].trim()}`);
        process.exit(0);
    }
    if (inString && stringChar !== '`') inString = false;
}
