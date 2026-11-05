const [port, body] = process.argv.slice(2);
const response = await fetch(`http://127.0.0.1:${port}/`, {
  method: "POST",
  body,
});
process.stdout.write(await response.text());
