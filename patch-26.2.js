const fs = require("fs");
const path = require("path");

function walk(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(p, results);
    } else if (entry.name === "protocol.json") {
      results.push(p);
    }
  }

  return results;
}

function recursivelyPatch(obj) {
  let changed = 0;

  if (!obj || typeof obj !== "object") return changed;

  if (
    obj.mappings &&
    typeof obj.mappings === "object"
  ) {
    const values = Object.values(obj.mappings);

    if (
      values.includes("packet_block_place") ||
      values.includes("packet_use_item")
    ) {
      console.log("Found serverbound play packet mapper");

      /*
       * Minecraft Java 26.2 / protocol 776:
       *
       * 0x40 teleport_to_entity
       * 0x41 test_instance_block_action
       * 0x42 block_place / use_item_on
       * 0x43 use_item
       * 0x44 custom_click_action
       */

      obj.mappings["0x40"] = "packet_teleport_to_entity";
      obj.mappings["0x41"] = "packet_test_instance_block_action";
      obj.mappings["0x42"] = "packet_block_place";
      obj.mappings["0x43"] = "packet_use_item";
      obj.mappings["0x44"] = "packet_custom_click_action";

      changed++;
    }
  }

  for (const value of Object.values(obj)) {
    changed += recursivelyPatch(value);
  }

  return changed;
}

const files = walk("node_modules");

let total = 0;

for (const file of files) {
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));

    const changed = recursivelyPatch(json);

    if (changed) {
      fs.writeFileSync(
        file,
        JSON.stringify(json, null, 2)
      );

      console.log(
        `Patched ${file} (${changed} mapping(s))`
      );

      total += changed;
    }
  } catch {}
}

if (!total) {
  console.error(
    "ERROR: Could not find the Minecraft serverbound packet mapping."
  );

  process.exit(1);
}

console.log(
  `Minecraft 26.2 protocol patch complete. ${total} mapping(s) changed.`
);
