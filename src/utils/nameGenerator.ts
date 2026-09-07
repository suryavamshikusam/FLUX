const colors = [
  'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink', 'Brown', 'Grey', 'Black', 
  'White', 'Cyan', 'Magenta', 'Lime', 'Olive', 'Teal', 'Navy', 'Maroon', 'Silver', 'Gold'
];

const animals = [
  'Ant', 'Bear', 'Cat', 'Dog', 'Elephant', 'Fox', 'Giraffe', 'Horse', 'Iguana', 'Jaguar',
  'Kangaroo', 'Lion', 'Monkey', 'Owl', 'Penguin', 'Rabbit', 'Snake', 'Tiger', 'Wolf', 'Zebra',
  'Panther', 'Falcon', 'Rhino', 'Dolphin', 'Eagle', 'Cheetah', 'Leopard', 'Koala', 'Panda'
];

export function generateRandomName(): string {
  const color = colors[Math.floor(Math.random() * colors.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  return `${color} ${animal}`;
}

export function getDeviceType(): string {
  const ua = navigator.userAgent;
  if (/Mobile|Android|iP(hone|od|ad)/.test(ua)) return 'Mobile';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Win/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Desktop';
}
