// pdfmake's browser build, which carries its own fonts and so bundles into one file: only what Atelier calls of it
declare module 'pdfmake/build/pdfmake' {
	const pdfMake: {
		addVirtualFileSystem(files: Record<string, string>): void;
		addFonts(fonts: Record<string, { normal: string; bold: string; italics: string; bolditalics: string }>): void;
		createPdf(definition: Record<string, unknown>): { getBuffer(): Promise<Uint8Array> };
	};
	export default pdfMake;
}

declare module 'pdfmake/build/vfs_fonts' {
	const files: Record<string, string>;
	export default files;
}
