const assert = require("node:assert/strict");

// Pass a Puppeteer Page already opened on index.html. No bundled browser required.
module.exports = async function verifyPrototype(page) {
  const checks = [];
  const state = () => page.$eval("#desktop", (el) => el.dataset.state);
  const bounds = () =>
    page.evaluate(() => {
      const desktop = document.getElementById("desktop"),
        pet = document.getElementById("pet-anchor");
      return {
        x: parseFloat(pet.style.left),
        y: parseFloat(pet.style.top),
        size: pet.offsetWidth,
        width: desktop.clientWidth,
        height: desktop.clientHeight,
      };
    });
  await page.setViewport({ width: 1440, height: 1100 });
  await page.emulateMediaFeatures([
    { name: "prefers-reduced-motion", value: "reduce" },
  ]);
  await page.reload({ waitUntil: "load" });
  await page.click("#reset-demo");
  assert.equal(await state(), "attention");
  const images = new Set();
  for (const expected of ["idle", "working", "attention", "unknown"]) {
    await page.click(`[data-scenario="${expected}"]`);
    assert.equal(await state(), expected);
    assert.deepEqual(
      await page.$$eval("#session-controls select", (selects) =>
        selects.map((s) => s.value),
      ),
      Array(3).fill(expected),
    );
    images.add(await page.$eval("#pet-canvas", (canvas) => canvas.toDataURL()));
  }
  assert.equal(
    images.size,
    4,
    "every state has a different reduced-motion rendering",
  );
  const staticA = await page.$eval("#pet-canvas", (canvas) =>
    canvas.toDataURL(),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    await page.$eval("#pet-canvas", (canvas) => canvas.toDataURL()),
    staticA,
  );
  checks.push(
    "Four state scenarios and distinct static reduced-motion artwork",
  );

  await page.click("#reset-demo");
  await page.click("#pet-button");
  assert.equal(await page.$eval("#session-popover", (el) => el.hidden), false);
  assert.deepEqual(
    await page.$$eval("[data-waiting]", (els) =>
      els.map((el) => el.dataset.waiting),
    ),
    ["a82f"],
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#session-popover", (el) => el.hidden), true);
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "pet-button",
  );
  checks.push("Pet opens correct wait list; Escape closes and restores focus");

  await page.select("#session-b91c", "attention");
  await page.select("#session-c13e", "working");
  await page.select("#session-a82f", "idle");
  assert.equal(await state(), "attention");
  await page.click("#pet-button");
  assert.deepEqual(
    await page.$$eval("[data-waiting]", (els) =>
      els.map((el) => el.dataset.waiting),
    ),
    ["b91c"],
  );
  await page.keyboard.press("Escape");
  await page.select("#session-b91c", "idle");
  assert.equal(await state(), "working");
  await page.select("#session-a82f", "unknown");
  assert.equal(await state(), "unknown");
  await page.select("#session-b91c", "attention");
  assert.equal(await state(), "attention");
  await page.click("#pet-button");
  assert.match(
    await page.$eval("#waiting-list", (el) => el.textContent),
    /a82f.*확인 불가/,
  );
  await page.keyboard.press("Escape");
  checks.push(
    "Same-project isolation, wait removal, working continuation, unknown/attention priority",
  );

  await page.click("#reset-position");
  await page.$eval("#pet-button", (el) =>
    el.scrollIntoView({ block: "center" }),
  );
  const start = await bounds();
  const box = await (await page.$("#pet-button")).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 - 140,
    box.y + box.height / 2 - 70,
    { steps: 12 },
  );
  await page.mouse.up();
  const end = await bounds();
  assert.ok(end.x < start.x - 100 && end.y < start.y - 40);
  assert.equal(
    await page.$eval("#session-popover", (el) => el.hidden),
    true,
    "drag is not a click",
  );
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(
    () => parseFloat(document.getElementById("pet-anchor").style.left) >= 0,
  );
  const restored = await bounds();
  assert.ok(
    Math.abs(restored.x - end.x) < 2 && Math.abs(restored.y - end.y) < 2,
  );
  await page.focus("#pet-button");
  await page.keyboard.press("ArrowLeft");
  assert.equal(Math.round((await bounds()).x), Math.round(restored.x - 10));
  checks.push(
    "Drag without accidental popover, persistence across reload, keyboard movement",
  );

  await page.click("#toggle-pet");
  assert.equal(await page.$eval("#pet-button", (el) => el.disabled), true);
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.documentElement.clientWidth === 390,
  );
  await page.click("#toggle-pet");
  await page.click("#reset-position");
  const mobile = await bounds();
  assert.ok(
    mobile.x >= 0 &&
      mobile.x + mobile.size <= mobile.width + 1 &&
      mobile.y + mobile.size <= mobile.height + 1,
  );
  await page.click("#pet-button");
  const contained = await page.evaluate(() => {
    const pop = document
        .getElementById("session-popover")
        .getBoundingClientRect(),
      desktop = document.getElementById("desktop").getBoundingClientRect();
    return (
      pop.left >= desktop.left &&
      pop.right <= desktop.right &&
      pop.top >= desktop.top &&
      pop.bottom <= desktop.bottom
    );
  });
  assert.ok(contained, "popover stays inside mobile desktop");
  await page.keyboard.press("Escape");
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewport({ width, height: 900 });
    await page.waitForFunction(
      (w) => document.documentElement.clientWidth === w,
      {},
      width,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `no horizontal overflow at ${width}`,
    );
  }
  checks.push(
    "Hide/show through resize, mobile popover containment, 320–1440px layouts",
  );

  await page.emulateMediaFeatures([
    { name: "prefers-reduced-motion", value: "no-preference" },
  ]);
  await page.click('[data-scenario="working"]');
  await page.$eval("#pet-button", (el) =>
    el.scrollIntoView({ block: "center" }),
  );
  const animatedA = await page.$eval("#pet-canvas", (el) => el.toDataURL());
  await new Promise((resolve) => setTimeout(resolve, 250));
  const animatedB = await page.$eval("#pet-canvas", (el) => el.toDataURL());
  assert.notEqual(animatedA, animatedB, "normal-motion mode animates");
  checks.push("Live reduced-motion preference changes resume animation");
  await page.click("#reset-demo");
  await page.evaluate(() => window.scrollTo(0, 0));
  return { passed: true, checks };
};
