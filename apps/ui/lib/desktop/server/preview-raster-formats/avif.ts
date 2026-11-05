import { inspectAv1Item } from './av1'
import { aggregate, Bytes, checkOpen, dimensions, fail } from './common'

type Box = { type: string; data: number; end: number }
export type AvifPlan = { width: number; height: number; aggregatePixels: number }
export function inspectAvif(bytes: Uint8Array, signal: AbortSignal): AvifPlan {
    const r = new Bytes(bytes)
    let boxCount = 0
    function boxes(start: number, end: number): Box[] {
        const out: Box[] = []
        while (start < end) {
            checkOpen(signal)
            if (++boxCount > 256) fail('unsupported')
            if (end - start < 8) fail('corrupt')
            let size = r.u32(start), header = 8
            if (size === 1) { size = r.uint(start + 8, 8); header = 16 }
            if (size < header || size > end - start) fail('corrupt')
            out.push({ type: r.ascii(start + 4, 4), data: start + header, end: start + size })
            start += size
        }
        return out
    }
    function one(list: Box[], type: string): Box {
        const matches = list.filter(box => box.type === type)
        if (matches.length !== 1) fail('corrupt')
        return matches[0]!
    }
    function full(box: Box, versions: number[] = [0], flags = 0): number {
        if (box.end - box.data < 4) fail('corrupt')
        const version = r.u8(box.data)
        if (!versions.includes(version) || (r.u32(box.data) & 0xffffff) !== flags) fail('unsupported')
        return version
    }
    function id(at: number, wide: boolean): number { return wide ? r.u32(at) : r.u16(at) }
    const top = boxes(0, bytes.length)
    if (top[0]?.type !== 'ftyp') fail('mismatch')
    if (top.some(box => box.type === 'moov')) fail('animation')
    if (top.some(box => !['ftyp', 'meta', 'mdat', 'free', 'skip'].includes(box.type))) fail('unsupported')
    const ftyp = one(top, 'ftyp')
    if (ftyp.end - ftyp.data > 256) fail('unsupported')
    if (ftyp.end - ftyp.data < 8 || (ftyp.end - ftyp.data) % 4 !== 0) fail('corrupt')
    const brands = [r.ascii(ftyp.data, 4)]
    for (let at = ftyp.data + 8; at < ftyp.end; at += 4) brands.push(r.ascii(at, 4))
    if (brands.includes('avis')) fail('animation')
    if (!brands.includes('avif')) fail('mismatch')
    const media = top.filter(box => box.type === 'mdat')
    if (!media.length || media.length > 8) fail('unsupported')
    const meta = one(top, 'meta'); full(meta)
    const children = boxes(meta.data + 4, meta.end)
    if (children.some(box => !['hdlr', 'pitm', 'iinf', 'iloc', 'iprp', 'iref'].includes(box.type))) fail('unsupported')
    const handler = one(children, 'hdlr'); full(handler)
    if (handler.end - handler.data < 24 || r.ascii(handler.data + 8, 4) !== 'pict') fail('unsupported')
    const pitm = one(children, 'pitm'), primaryVersion = full(pitm, [0, 1])
    if (pitm.end - pitm.data !== (primaryVersion === 0 ? 6 : 8)) fail('corrupt')
    const primary = id(pitm.data + 4, primaryVersion === 1)
    const iinf = one(children, 'iinf'), infoVersion = full(iinf, [0, 1]), countSize = infoVersion === 0 ? 2 : 4
    const count = id(iinf.data + 4, countSize === 4)
    if (count < 1 || count > 2) fail('unsupported')
    const entries = boxes(iinf.data + 4 + countSize, iinf.end), items = new Set<number>()
    if (entries.length !== count) fail('corrupt')
    for (const entry of entries) {
        if (entry.type !== 'infe') fail('corrupt')
        const infoFlags = r.u32(entry.data) & 0xffffff
        if (infoFlags > 1) fail('unsupported')
        const version = full(entry, [2, 3], infoFlags), wide = version === 3, size = wide ? 4 : 2
        const item = id(entry.data + 4, wide)
        if (!item || items.has(item) || r.u16(entry.data + 4 + size) !== 0) fail('corrupt')
        if (r.ascii(entry.data + 6 + size, 4) !== 'av01') fail('unsupported')
        const name = entry.data + 10 + size
        if (entry.end <= name || entry.end - name > 1024 || r.u8(entry.end - 1) !== 0) fail('corrupt')
        items.add(item)
    }
    if (!items.has(primary)) fail('corrupt')
    const iprp = one(children, 'iprp'), propertyChildren = boxes(iprp.data, iprp.end)
    if (propertyChildren.length !== 2) fail('unsupported')
    const ipco = one(propertyChildren, 'ipco'), properties = boxes(ipco.data, ipco.end)
    if (properties.length > 32) fail('unsupported')
    const sizes = new Map<number, { width: number; height: number }>(), alphas = new Set<number>(), configs = new Map<number, Uint8Array>()
    properties.forEach((property, index) => {
        const key = index + 1
        if (property.type === 'ispe') {
            full(property)
            if (property.end - property.data !== 12) fail('corrupt')
            const width = r.u32(property.data + 4), height = r.u32(property.data + 8)
            dimensions(width, height); sizes.set(key, { width, height })
        } else if (property.type === 'av1C') {
            if (property.end - property.data < 4 || property.end - property.data > 65_536 || r.u8(property.data) !== 0x81 || (r.u8(property.data + 1) >>> 5) > 2 || (r.u8(property.data + 3) & 0xe0) !== 0 || (!(r.u8(property.data + 3) & 0x10) && (r.u8(property.data + 3) & 15) !== 0)) fail('corrupt')
            configs.set(key, bytes.subarray(property.data + 4, property.end))
        } else if (property.type === 'pixi') {
            full(property)
            const channels = r.u8(property.data + 4)
            if (![1, 3, 4].includes(channels) || property.end - property.data !== 5 + channels) fail('corrupt')
            for (let c = 0; c < channels; c++) if (![8, 10, 12].includes(r.u8(property.data + 5 + c))) fail('unsupported')
        } else if (property.type === 'colr') {
            if (property.end - property.data !== 11 || r.ascii(property.data, 4) !== 'nclx') fail('unsupported')
        } else if (property.type === 'auxC') {
            full(property)
            const alphaType = 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0'
            if (property.end - property.data !== alphaType.length + 4 || r.ascii(property.data + 4, alphaType.length) !== alphaType) fail('unsupported')
            alphas.add(key)
        } else fail('unsupported')
    })
    const ipma = one(propertyChildren, 'ipma'), ipmaFlags = r.u32(ipma.data) & 0xffffff
    if (ipmaFlags > 1) fail('unsupported')
    const associationVersion = full(ipma, [0, 1], ipmaFlags), wideId = associationVersion === 1, wideIndex = ipmaFlags === 1
    let at = ipma.data + 4
    const associatedCount = r.u32(at); at += 4
    if (associatedCount !== items.size) fail('corrupt')
    const associations = new Map<number, number[]>()
    for (let index = 0; index < associatedCount; index++) {
        const item = id(at, wideId); at += wideId ? 4 : 2
        const number = r.u8(at++), props: number[] = []
        if (!items.has(item) || associations.has(item) || number > properties.length) fail('corrupt')
        for (let p = 0; p < number; p++) {
            const property = (wideIndex ? r.u16(at) : r.u8(at)) & (wideIndex ? 0x7fff : 0x7f); at += wideIndex ? 2 : 1
            if (!property || property > properties.length || props.includes(property)) fail('corrupt')
            props.push(property)
        }
        associations.set(item, props)
    }
    if (at !== ipma.end) fail('corrupt')
    let aggregatePixels = 0, primarySize: { width: number; height: number } | undefined, alphaItem: number | undefined
    for (const [item, props] of associations) {
        const sizeProperties = props.filter(prop => sizes.has(prop)), configProperties = props.filter(prop => configs.has(prop))
        if (sizeProperties.length !== 1 || configProperties.length !== 1) fail('corrupt')
        const size = sizes.get(sizeProperties[0]!)!
        aggregatePixels += size.width * size.height; aggregate(aggregatePixels)
        const isAlpha = props.some(prop => alphas.has(prop))
        if (item === primary) { if (isAlpha) fail('corrupt'); primarySize = size }
        else { if (!isAlpha) fail('unsupported'); alphaItem = item }
    }
    if (!primarySize) fail('corrupt')
    if (alphaItem !== undefined) {
        const alphaSize = sizes.get(associations.get(alphaItem)!.find(prop => sizes.has(prop))!)!
        if (alphaSize.width !== primarySize.width || alphaSize.height !== primarySize.height) fail('corrupt')
    }
    const references = children.filter(box => box.type === 'iref')
    if (references.length > 1 || (alphaItem !== undefined && references.length !== 1)) fail('corrupt')
    if (references.length) {
        const reference = references[0]!, wide = full(reference, [0, 1]) === 1, refs = boxes(reference.data + 4, reference.end)
        if (refs.length !== (alphaItem === undefined ? 0 : 1)) fail('unsupported')
        for (const ref of refs) {
            const size = wide ? 4 : 2
            if (ref.type !== 'auxl' || ref.end - ref.data !== size * 2 + 2 || id(ref.data, wide) !== alphaItem || r.u16(ref.data + size) !== 1 || id(ref.data + size + 2, wide) !== primary) fail('unsupported')
        }
    }
    const iloc = one(children, 'iloc'), locationVersion = full(iloc, [0, 1, 2])
    at = iloc.data + 4
    const offsetSize = r.u8(at) >>> 4, lengthSize = r.u8(at++) & 15, baseSize = r.u8(at) >>> 4, indexSize = locationVersion > 0 ? r.u8(at) & 15 : 0
    if (locationVersion === 0 && (r.u8(at) & 15) !== 0) fail('corrupt')
    at++
    if (![0, 4, 8].includes(offsetSize) || ![4, 8].includes(lengthSize) || ![0, 4, 8].includes(baseSize) || ![0, 4, 8].includes(indexSize)) fail('unsupported')
    const locationCount = id(at, locationVersion === 2); at += locationVersion === 2 ? 4 : 2
    if (locationCount !== items.size) fail('corrupt')
    const located = new Set<number>(), extents: Array<{ start: number; end: number }> = [], itemExtents = new Map<number, Uint8Array[]>()
    for (let i = 0; i < locationCount; i++) {
        const item = id(at, locationVersion === 2); at += locationVersion === 2 ? 4 : 2
        if (!items.has(item) || located.has(item)) fail('corrupt')
        located.add(item)
        if (locationVersion > 0) { if (r.u16(at) !== 0) fail('unsupported'); at += 2 }
        if (r.u16(at) !== 0) fail('unsupported')
        at += 2
        const base = r.uint(at, baseSize); at += baseSize
        const count = r.u16(at); at += 2
        if (count < 1 || count > 16) fail('unsupported')
        for (let extent = 0; extent < count; extent++) {
            if (indexSize) { if (r.uint(at, indexSize) !== 0) fail('unsupported'); at += indexSize }
            const offset = r.uint(at, offsetSize); at += offsetSize
            const length = r.uint(at, lengthSize); at += lengthSize
            const start = base + offset, end = start + length
            if (!length || !Number.isSafeInteger(end) || !media.some(box => start >= box.data && end <= box.end)) fail('corrupt')
            extents.push({ start, end })
            itemExtents.set(item, [...(itemExtents.get(item) ?? []), bytes.subarray(start, end)])
        }
    }
    if (at !== iloc.end) fail('corrupt')
    extents.sort((a, b) => a.start - b.start)
    for (let i = 1; i < extents.length; i++) if (extents[i]!.start < extents[i - 1]!.end) fail('corrupt')
    for (const [item, parts] of itemExtents) {
        const props = associations.get(item)!, size = sizes.get(props.find(prop => sizes.has(prop))!)!
        const config = configs.get(props.find(prop => configs.has(prop))!)!
        const data = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
        let offset = 0
        for (const part of parts) { data.set(part, offset); offset += part.length }
        inspectAv1Item(config, data, size, signal)
    }
    return { ...primarySize, aggregatePixels }
}
