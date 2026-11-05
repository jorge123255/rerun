export const PRIVATE_TEXT_BYTES = 256 * 1024
export function privateTextPath(path:string) {
    if(!path || path.length>1024 || path.includes('\\') || path.includes('\0') || path.startsWith('/') || path.split('/').some(p=>!p || p.startsWith('.')) || !/\.(txt|md)$/i.test(path))throw new Error('Choose a visible private .txt or .md file')
    return path
}
export function boundedPrivateText(content:string) {
    if(Buffer.byteLength(content,'utf8')>PRIVATE_TEXT_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content) || new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(content))!==content)throw new Error('Complete UTF-8 text up to 256 KiB is required')
    return content
}
export function editPrivateText(content:string,oldString:string,newString:string,replaceAll=false) {
    boundedPrivateText(content)
    if(!oldString)throw new Error('oldString must not be empty')
    const occurrences=content.split(oldString).length-1
    if(!occurrences)throw new Error('oldString not found')
    if(occurrences>1 && !replaceAll)throw new Error(`oldString matches ${occurrences} times; pass replaceAll or provide a more specific string`)
    return {content:boundedPrivateText(content.split(oldString).join(newString)),occurrences}
}
