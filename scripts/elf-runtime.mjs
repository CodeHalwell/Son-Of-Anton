/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Only native ELF64 objects with dynamic dependencies belong in shlibdeps. */
export function needsNativeLibraries(bytes, machine = 62) {
	if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== machine) { return false; }
	const headers = Number(bytes.readBigUInt64LE(32)), width = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
	if (!Number.isSafeInteger(headers) || width < 56 || headers + width * count > bytes.length) { return false; }
	for (let index = 0; index < count; index++) {
		const header = headers + index * width;
		if (bytes.readUInt32LE(header) !== 2) { continue; } // PT_DYNAMIC
		const start = Number(bytes.readBigUInt64LE(header + 8)), size = Number(bytes.readBigUInt64LE(header + 32));
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start + size > bytes.length) { return false; }
		for (let offset = start; offset + 16 <= start + size; offset += 16) {
			const tag = bytes.readBigInt64LE(offset);
			if (tag === 1n) { return true; } // DT_NEEDED
			if (tag === 0n) { break; }
		}
	}
	return false;
}
