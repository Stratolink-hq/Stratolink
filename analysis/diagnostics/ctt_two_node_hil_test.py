#!/usr/bin/env python3
"""Regression-test the strict two-node CTT HIL evidence evaluator."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

import ctt_two_node_hil


def put_detection(
    queue: bytearray,
    offset: int,
    *,
    raw: int,
    motus: int,
    hits: int,
    motus_valid: bool,
) -> None:
    struct.pack_into("<IIhBBHI", queue, offset, raw, motus, -83, hits,
                     int(motus_valid), 0, 7)


def passing_blobs() -> tuple[bytes, bytes, bytes]:
    stats = bytearray(32)
    struct.pack_into("<IIIIIIh", stats, 0, 24, 1, 21, 1, 0,
                     0x01020304, -83)
    struct.pack_into("<I", stats, 28, 5)

    queue = bytearray(648)
    put_detection(
        queue,
        320,
        raw=ctt_two_node_hil.REFERENCE_RAW,
        motus=0x3256E,
        hits=3,
        motus_valid=True,
    )
    put_detection(
        queue,
        340,
        raw=ctt_two_node_hil.NON_DICTIONARY_RAW,
        motus=0,
        hits=1,
        motus_valid=False,
    )
    queue[640] = 16
    queue[644] = 16

    tx = bytearray(44)
    struct.pack_into("<I", tx, 0, 0x43545831)
    struct.pack_into("<III", tx, 12, 24, 24, 0)
    struct.pack_into("<hh", tx, 24, 0, 0)
    struct.pack_into("<b", tx, 28, -9)
    tx[29] = 24
    tx[30] = 24
    tx[37] = 1
    tx[38] = 1
    return bytes(stats), bytes(queue), bytes(tx)


def evaluate(
    root: Path, stats: bytes, queue: bytes, tx: bytes, name: str
) -> tuple[Path, bool]:
    stats_path = root / f"{name}_stats.bin"
    queue_path = root / f"{name}_queue.bin"
    tx_path = root / f"{name}_tx.bin"
    output = root / f"{name}_result.json"
    stats_path.write_bytes(stats)
    queue_path.write_bytes(queue)
    tx_path.write_bytes(tx)
    args = argparse.Namespace(
        receiver_stats=stats_path,
        receiver_queue=queue_path,
        transmitter_state=tx_path,
        output=output,
    )
    try:
        ctt_two_node_hil.evaluate(args)
    except SystemExit:
        return output, False
    return output, True


class EvidencePathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="ctt-path-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.inputs = [self.root / name for name in ("stats", "queue", "tx")]
        self.blobs = passing_blobs()
        for path, blob in zip(self.inputs, self.blobs):
            path.write_bytes(blob)

    def args(self, output: Path) -> argparse.Namespace:
        return argparse.Namespace(
            receiver_stats=self.inputs[0], receiver_queue=self.inputs[1],
            transmitter_state=self.inputs[2], output=output,
        )

    def test_existing_result_is_unchanged(self) -> None:
        output = self.root / "result.json"
        output.write_bytes(b"previous evidence")
        with self.assertRaises((SystemExit, FileExistsError)):
            ctt_two_node_hil.evaluate(self.args(output))
        self.assertEqual(output.read_bytes(), b"previous evidence")

    def test_output_cannot_alias_input(self) -> None:
        for index, source in enumerate(self.inputs):
            with self.subTest(source=source.name):
                for kind in ("direct", "symlink", "hardlink"):
                    for path, blob in zip(self.inputs, self.blobs):
                        path.write_bytes(blob)
                    output = self.root / f"alias-{index}-{kind}"
                    if kind == "direct":
                        output = source
                    elif kind == "symlink":
                        output.symlink_to(source)
                    else:
                        os.link(source, output)
                    with self.assertRaises((SystemExit, FileExistsError)):
                        ctt_two_node_hil.evaluate(self.args(output))
                    self.assertEqual(source.read_bytes(), self.blobs[index])

    def test_dangling_output_symlink_is_rejected(self) -> None:
        target = self.root / "must-not-create"
        output = self.root / "result.json"
        output.symlink_to(target)
        with self.assertRaises((SystemExit, FileExistsError)):
            ctt_two_node_hil.evaluate(self.args(output))
        self.assertFalse(target.exists())

    def test_generate_preflights_every_output(self) -> None:
        for index, name in enumerate((
            "manifest.json", "read_receiver.jlink", "read_transmitter.jlink",
        )):
            with self.subTest(name=name):
                output = self.root / str(index)
                output.mkdir()
                existing = output / name
                existing.write_bytes(b"previous evidence")
                args = argparse.Namespace(
                    receiver_elf=self.inputs[0], transmitter_elf=self.inputs[1],
                    output_dir=output,
                )
                with patch.object(ctt_two_node_hil, "require_symbols", return_value={}):
                    with self.assertRaises((SystemExit, FileExistsError)):
                        ctt_two_node_hil.generate(args)
                self.assertEqual(existing.read_bytes(), b"previous evidence")
                self.assertEqual(list(output.iterdir()), [existing])

    def test_generate_refuses_input_alias_and_dangling_symlink(self) -> None:
        for index, kind in enumerate(("symlink", "hardlink", "dangling")):
            with self.subTest(kind=kind):
                output = self.root / str(index)
                output.mkdir()
                destination = output / "manifest.json"
                target = self.root / "missing" if kind == "dangling" else self.inputs[0]
                if kind == "hardlink":
                    os.link(target, destination)
                else:
                    destination.symlink_to(target)
                args = argparse.Namespace(
                    receiver_elf=self.inputs[0], transmitter_elf=self.inputs[1],
                    output_dir=output,
                )
                with patch.object(ctt_two_node_hil, "require_symbols") as symbols:
                    with self.assertRaises((SystemExit, FileExistsError)):
                        ctt_two_node_hil.generate(args)
                    symbols.assert_not_called()
                self.assertEqual(self.inputs[0].read_bytes(), self.blobs[0])
                self.assertFalse((self.root / "missing").exists())

    def test_fresh_bundle_is_complete_and_private(self) -> None:
        output = self.root / "new parent" / "bundle"
        args = argparse.Namespace(
            receiver_elf=self.inputs[0], transmitter_elf=self.inputs[1],
            output_dir=output,
        )
        previous = os.umask(0o022)
        try:
            with patch.object(ctt_two_node_hil, "require_symbols", side_effect=[
                {"s_ctt": {"address": 0x20000000, "size": 32}},
                {"ctt_tx_diag_state": {"address": 0x20000100, "size": 44}},
            ]):
                ctt_two_node_hil.generate(args)
        finally:
            os.umask(previous)
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)
        self.assertEqual(output.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(len(list(output.iterdir())), 3)
        for path in output.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        manifest = json.loads((output / "manifest.json").read_text())
        self.assertEqual(manifest["receiver"]["elf_sha256"], ctt_two_node_hil.sha256(self.inputs[0]))
        self.assertIn("savebin ctt_receiver_s_ctt.bin", (output / "read_receiver.jlink").read_text())


def main() -> None:
    read_script = ctt_two_node_hil.savebin_script(
        {
            "s_ctt": {"address": 0x200007E0, "size": 32},
            "s_ctt_queue": {"address": 0x20000558, "size": 648},
        },
        "ctt_receiver",
    )
    assert (
        "savebin ctt_receiver_s_ctt.bin 0x200007E0 0x20" in read_script
    )
    assert (
        "savebin ctt_receiver_s_ctt_queue.bin 0x20000558 0x288"
        in read_script
    )

    stats, queue, tx = passing_blobs()
    with tempfile.TemporaryDirectory(prefix="stratolink-ctt-hil-test-") as tmp:
        root = Path(tmp)

        pass_output, accepted = evaluate(root, stats, queue, tx, "pass")
        assert accepted
        pass_result = json.loads(pass_output.read_text(encoding="utf-8"))
        assert pass_result["passed"] is True
        assert all(pass_result["checks"].values())

        corrupt_tx = bytearray(tx)
        struct.pack_into("<I", corrupt_tx, 16, 23)
        fail_output, accepted = evaluate(
            root, stats, queue, bytes(corrupt_tx), "tx_short"
        )
        assert not accepted
        fail_result = json.loads(fail_output.read_text(encoding="utf-8"))
        assert fail_result["passed"] is False
        assert fail_result["checks"]["tx_all_success"] is False

        corrupt_queue = bytearray(queue)
        corrupt_queue[330] = 2
        fail_output, accepted = evaluate(
            root, stats, bytes(corrupt_queue), tx, "reference_hits"
        )
        assert not accepted
        fail_result = json.loads(fail_output.read_text(encoding="utf-8"))
        assert fail_result["checks"]["rx_reference_aggregated"] is False

    print("PASS: CTT two-node evaluator accepts exact evidence and fails closed")


if __name__ == "__main__":
    main()
    unittest.main()
