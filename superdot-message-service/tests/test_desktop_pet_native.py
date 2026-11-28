from copy import deepcopy
from unittest import TestCase
from unittest.mock import Mock, patch

from noticehub.web.desktop_pet import DesktopPet, PREFIX


class NativePetSettingsTest(TestCase):
    def setUp(self):
        self.pet = DesktopPet(Mock(), Mock(), 54321, "")
        self.pet.store.meta_get.side_effect = lambda key, default="": default
        self.pet.connected = True
        self.config = {"main": {"pets": [
            {"id": "main", "display": "web", "size": 200, "sizePercent": 10},
            {"id": "other", "size": 120}],
            "voiceVolume": 0.4, "voiceEnabled": True, "custom": "keep"}}
        self.pet._read_native(self.config)

    def test_edit_preserves_other_pets_and_uses_native_partial_global_update(self):
        def save(path, payload, *, method, extra_headers):
            self.assertEqual((path, method), (PREFIX + "/config", "PUT"))
            self.assertEqual(payload, {"pets": self.config["main"]["pets"], "voiceVolume": 0})
            return 200, {"main": {**self.config["main"], **payload}}

        with patch.object(self.pet, "_ready", return_value=self.config["main"]), patch.object(self.pet.client, "request", side_effect=save):
            self.pet.set_native("voiceVolume", 0)
        self.assertEqual(self.pet.status()["native"]["voiceVolume"], 0)

    def test_show_desktop_preserves_web_visibility(self):
        result = deepcopy(self.config)
        result["main"]["pets"][0]["display"] = "both"
        with patch.object(self.pet, "_ready", return_value=self.config["main"]), patch.object(self.pet, "_call", return_value=result) as save:
            self.pet.set_native("visible", True)
            save.assert_called_once_with("/pet-display", {"id": "main", "display": "both"})
        self.assertTrue(self.pet.status()["native"]["visible"])

    def test_size_switches_to_pixel_units_only_for_selected_pet(self):
        result = deepcopy(self.config)
        result["main"]["pets"][0].update(size=240)
        del result["main"]["pets"][0]["sizePercent"]
        with patch.object(self.pet, "_ready", return_value=self.config["main"]), patch.object(self.pet.client, "request", return_value=(200, result)) as save:
            self.pet.set_native("size", 240)
            self.assertEqual(save.call_args.args[1], {"pets": result["main"]["pets"]})

    def test_rejects_unknown_keys_and_invalid_values_before_connecting(self):
        with patch.object(self.pet, "_ready") as ready:
            for key, value in [("voiceName", "bad"), ("fixedEnabled", 1), ("size", True), ("voiceVolume", 1.1)]:
                with self.assertRaises(ValueError):
                    self.pet.set_native(key, value)
            ready.assert_not_called()
