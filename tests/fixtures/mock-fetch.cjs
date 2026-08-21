const json = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("commons.wikimedia.org/w/api.php") && url.includes("list=search")) {
    return json({ query: { search: [{ title: "File:Wrong subject.png" }] } });
  }
  if (url.includes("commons.wikimedia.org/w/api.php") && url.includes("prop=imageinfo")) {
    return json({
      query: {
        pages: {
          1: {
            imageinfo: [{
              mime: "image/png",
              thumburl: "https://fixtures.invalid/wrong-subject.png",
              descriptionurl: "https://commons.wikimedia.org/wiki/File:Wrong_subject.png",
              extmetadata: {
                Artist: { value: "Fixture Author" },
                LicenseShortName: { value: "CC0" },
              },
            }],
          },
        },
      },
    });
  }
  if (url === "https://fixtures.invalid/wrong-subject.png") {
    return new Response(Buffer.from("89504e470d0a1a0a", "hex"), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }
  if (url === "https://api.openai.com/v1/chat/completions") {
    return json({
      choices: [{
        message: {
          content: JSON.stringify({
            score: 0.2,
            isCorrect: false,
            reason: "fixture is the wrong subject",
            confusedWith: "fixture lookalike",
          }),
        },
      }],
    });
  }
  throw new Error(`unexpected offline fetch: ${url}`);
};
