declare module "pdf-parse/lib/pdf-parse.js" {
  function pdf(data: Buffer, options?: { pagerender?: (page: any) => Promise<string> }): Promise<{ text: string; numpages: number }>;
  export default pdf;
}
