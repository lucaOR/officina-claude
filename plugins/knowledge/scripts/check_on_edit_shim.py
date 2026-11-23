"""Import shim: check-on-edit.py is hyphenated and lives in the plugin's hooks/ directory, so it
cannot be imported by name. Exists only so test_postcommit can assert that
postcommit.CHECKABLE has not drifted from the edit hook's."""
import importlib.util
from pathlib import Path

_p = Path(__file__).resolve().parents[1] / "hooks" / "check-on-edit.py"
_spec = importlib.util.spec_from_file_location("check_on_edit", _p)
check_on_edit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_on_edit)

CHECKABLE = check_on_edit.CHECKABLE
