export type MusicTrack = {
  file: string;
  name: string;
  author: string;
  seconds: number;
  source: string;
  license: string;
};

export const MUSIC: MusicTrack[] = [
  {
    file: "drifting-pines.mp3",
    name: "Drifting Pines",
    author: "Dieu_Anh",
    seconds: 195,
    source:
      "https://pixabay.com/music/folk-drifting-pines-acoustic-folk-guitar-instrumental-545147/",
    license: "Pixabay Content License",
  },
  {
    file: "all-over-again.mp3",
    name: "All Over Again",
    author: "Music_for_Creators",
    seconds: 133,
    source: "https://pixabay.com/music/folk-all-over-again-383370/",
    license: "Pixabay Content License",
  },
  {
    file: "thinking-of-home.mp3",
    name: "Thinking of Home",
    author: "22941069",
    seconds: 82,
    source: "https://pixabay.com/music/solo-guitar-thinking-of-home-acoustic-guitar-piece-11885/",
    license: "Pixabay Content License",
  },
  {
    file: "family-music-andriig.mp3",
    name: "Family - Family Music",
    author: "andriig",
    seconds: 132,
    source: "https://pixabay.com/music/acoustic-group-family-family-music-504413/",
    license: "Pixabay Content License",
  },
];
