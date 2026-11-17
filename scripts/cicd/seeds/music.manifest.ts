const suffix = (index: number): string => String(index + 1).padStart(12, "0");

export const musicMediaId = (file: string): string => {
  const index = MUSIC.findIndex((track) => track.file === file);
  if (index < 0) throw new Error(`seeds: no music track ${file}`);
  return `cccccccc-cccc-4ccc-8ccc-${suffix(index)}`;
};

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
  {
    file: "forever-in-my-heart.mp3",
    name: "Forever in My Heart",
    author: "Michael Ramir C.",
    seconds: 149,
    source: "https://mixkit.co/free-stock-music/forever-in-my-heart/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "i-love-you-grandma.mp3",
    name: "I Love You Grandma",
    author: "Michael Ramir C.",
    seconds: 114,
    source: "https://mixkit.co/free-stock-music/i-love-you-grandma/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "our-journey.mp3",
    name: "Our Journey",
    author: "Michael Ramir C.",
    seconds: 163,
    source: "https://mixkit.co/free-stock-music/our-journey/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "hip-hop-02.mp3",
    name: "Hip Hop 02",
    author: "Lily J",
    seconds: 115,
    source: "https://mixkit.co/free-stock-music/hip-hop-02/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "c-b-p-d.mp3",
    name: "C.B.P.D",
    author: "Arulo",
    seconds: 99,
    source: "https://mixkit.co/free-stock-music/c-b-p-d/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "karma.mp3",
    name: "Karma",
    author: "Michael Ramir C.",
    seconds: 135,
    source: "https://mixkit.co/free-stock-music/karma/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "these-nights.mp3",
    name: "These Nights",
    author: "Ahjay Stelino",
    seconds: 101,
    source: "https://mixkit.co/free-stock-music/these-nights/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "sweet-september.mp3",
    name: "Sweet September",
    author: "Arulo",
    seconds: 99,
    source: "https://mixkit.co/free-stock-music/sweet-september/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "day-dreamin-with-u.mp3",
    name: "Day Dreamin' with U",
    author: "Michael Ramir C.",
    seconds: 118,
    source: "https://mixkit.co/free-stock-music/day-dreamin-with-u/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "i-wont-surrender.mp3",
    name: "I Won't surrender",
    author: "Michael Ramir C.",
    seconds: 114,
    source: "https://mixkit.co/free-stock-music/i-wont-surrender/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "epical-drums-01.mp3",
    name: "Epical Drums 01",
    author: "Grigoriy Nuzhny",
    seconds: 106,
    source: "https://mixkit.co/free-stock-music/epical-drums-01/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "epical-drums-05.mp3",
    name: "Epical Drums 05",
    author: "Grigoriy Nuzhny",
    seconds: 102,
    source: "https://mixkit.co/free-stock-music/epical-drums-05/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "bob.mp3",
    name: "Bob",
    author: "Michael Ramir C.",
    seconds: 122,
    source: "https://mixkit.co/free-stock-music/bob/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "fun-and-games.mp3",
    name: "Fun and Games",
    author: "Ahjay Stelino",
    seconds: 139,
    source: "https://mixkit.co/free-stock-music/fun-and-games/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "kidding-around.mp3",
    name: "Kidding Around",
    author: "Ahjay Stelino",
    seconds: 107,
    source: "https://mixkit.co/free-stock-music/kidding-around/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "funkee-monkeee.mp3",
    name: "Funkee Monkeee",
    author: "Michael Ramir C.",
    seconds: 98,
    source: "https://mixkit.co/free-stock-music/funkee-monkeee/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "funky-martian.mp3",
    name: "Funky Martian",
    author: "Michael Ramir C.",
    seconds: 100,
    source: "https://mixkit.co/free-stock-music/funky-martian/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "this-our-year.mp3",
    name: "This Our Year! (Happy New Year!)",
    author: "Michael Ramir C.",
    seconds: 142,
    source: "https://mixkit.co/free-stock-music/this-our-year-happy-new-year/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "follow-me-home.mp3",
    name: "Follow Me Home",
    author: "Arulo",
    seconds: 74,
    source: "https://mixkit.co/free-stock-music/follow-me-home/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "positive-energy.mp3",
    name: "Positive Energy",
    author: "Michael Ramir C.",
    seconds: 91,
    source: "https://mixkit.co/free-stock-music/positive-energy/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "sounds-good.mp3",
    name: "Sounds Good",
    author: "Michael Ramir C.",
    seconds: 96,
    source: "https://mixkit.co/free-stock-music/sounds-good/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "we-will-get-it.mp3",
    name: "We Will Get It",
    author: "Eugenio Mininni",
    seconds: 269,
    source: "https://mixkit.co/free-stock-music/we-will-get-it/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "a-new-life.mp3",
    name: "A New Life",
    author: "Eugenio Mininni",
    seconds: 99,
    source: "https://mixkit.co/free-stock-music/a-new-life/",
    license: "Mixkit Stock Music Free License",
  },
  {
    file: "lifes-a-movie.mp3",
    name: "Life's a Movie",
    author: "Arulo",
    seconds: 121,
    source: "https://mixkit.co/free-stock-music/lifes-a-movie/",
    license: "Mixkit Stock Music Free License",
  },
];
