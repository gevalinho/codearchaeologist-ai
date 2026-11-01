module.exports = function phpParserBrowserArchLoader(source) {
  const marker = "process.arch";
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error("Unexpected php-parser browser bundle architecture probe.");
  }
  return source.replace(marker, '"x64"');
};
