// src/components/LecturePlayer.js
import React from 'react';

const LecturePlayer = ({ filePath }) => {
  return (
    <video width="600" controls>
      <source src={`file://${filePath}`} type="video/mp4" />
      Your browser does not support the video tag.
    </video>
  );
};

export default LecturePlayer;
