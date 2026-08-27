import os
import sys

# Make deploy/runtime-agent importable so tests can `import liveness` the same
# way main.py does (both files sit next to each other in the deployed bundle).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
