// The standalone pdfkit build has the same API as the main package; reuse its types.
declare module 'pdfkit/js/pdfkit.standalone' {
  import PDFDocument from 'pdfkit';
  export default PDFDocument;
}
