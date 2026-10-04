// Импорты `?raw` (vite): файлы корпуса и артефакта решений читаются как текст.
declare module '*?raw' {
  const content: string;
  export default content;
}
