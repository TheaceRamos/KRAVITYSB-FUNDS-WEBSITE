const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  let filePath = req.url === "/" 
    ? path.join(__dirname, "index.html")
    : path.join(__dirname, req.url);

  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, "index.html");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end("Server error");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html"
    });

    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
