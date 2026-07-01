// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.

// Ambient type declaration for `pixelmatch` v6, which ships as ESM with no
// bundled types. The runtime module is consumed via esModuleInterop (Node's
// require-of-ESM resolves the default export to a callable function).
declare module 'pixelmatch' {
	type PixelmatchImage = Uint8Array | Uint8ClampedArray | Buffer;

	interface PixelmatchOptions {
		/** Matching threshold (0 to 1); smaller is more sensitive. Default 0.1. */
		threshold?: number;
		/** If true, disables detecting and ignoring anti-aliased pixels. Default false. */
		includeAA?: boolean;
		/** Blending factor of unchanged pixels in the diff output. Default 0.1. */
		alpha?: number;
		/** The color of anti-aliased pixels in the diff output as [r, g, b]. */
		aaColor?: [number, number, number];
		/** The color of differing pixels in the diff output as [r, g, b]. */
		diffColor?: [number, number, number];
		/** An alternative color for dark-on-light differences as [r, g, b]. */
		diffColorAlt?: [number, number, number];
		/** Draw the diff over a transparent background (a mask). Default false. */
		diffMask?: boolean;
	}

	/**
	 * Compares two images and returns the number of mismatched pixels, optionally
	 * writing a visual diff into `output`.
	 */
	function pixelmatch(
		img1: PixelmatchImage,
		img2: PixelmatchImage,
		output: PixelmatchImage | null,
		width: number,
		height: number,
		options?: PixelmatchOptions
	): number;

	export default pixelmatch;
}
