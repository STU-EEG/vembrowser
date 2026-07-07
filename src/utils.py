from collections import defaultdict
from pathlib import Path
from typing import List, Tuple
import pickle
import re
import logging


import numpy as np
import cv2

# copied from small-movts
class KeypointsInfo:
    head_centers: dict[int, list[tuple[int, int]]] = defaultdict(list)  # {person_idx: [(x, y), ... (for each frame)] }
    shoulder_distances: dict[int, list[np.float32]] = defaultdict(list)  # {person_idx: distances for each frame }
    frame_indices: dict[int, list[int]] = defaultdict(list)

    max_frame_idx: int = 0

    def __init__(self) -> None:
        self.head_centers = defaultdict(list)
        self.shoulder_distances = defaultdict(list)
        self.frame_indices = defaultdict(list)
