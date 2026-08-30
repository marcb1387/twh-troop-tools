// Canonical list of official BSA merit badges, kept independent of any
// single troop's TWH export (which only ever contains badges someone has
// actually started/earned) so reports can show gaps - badges the troop
// has never touched at all.
const OFFICIAL_BADGES = [
  "American Business","American Cultures","American Heritage","American Indian Culture",
  "American Labor","Animal Science","Animation","Archaeology","Archery","Architecture",
  "Art","Artificial Intelligence","Astronomy","Athletics","Automotive Maintenance",
  "Aviation","Backpacking","Basketry","Bird Study","Bugling","Camping","Canoeing",
  "Chemistry","Chess","Citizenship in Society","Citizenship in the Community",
  "Citizenship in the Nation","Citizenship in the World","Climbing","Coin Collecting",
  "Collections","Communication","Competitive Gaming","Composite Materials","Cooking","Crime Prevention",
  "Cybersecurity","Cycling","Dentistry","Digital Technology","Disabilities Awareness",
  "Dog Care","Drafting","Electricity","Electronics","Emergency Preparedness","Energy",
  "Engineering","Entrepreneurship","Environmental Science","Exploration","Family Life",
  "Farm Mechanics","Fingerprinting","Fire Safety","First Aid","Fish & Wildlife Management",
  "Fishing","Fly Fishing","Forestry","Game Design","Gardening","Genealogy","Geocaching",
  "Geology","Golf","Graphic Arts","Health Care Professions","Hiking","Home Repairs",
  "Horsemanship","Insect Study","Inventing","Journalism","Kayaking",
  "Landscape Architecture","Law","Leatherwork","Lifesaving","Mammal Study","Metalwork",
  "Mining in Society","Model Design and Building","Motorboating","Moviemaking","Multisport",
  "Music","Nature","Nuclear Science","Oceanography","Orienteering","Painting",
  "Personal Fitness","Personal Management","Pets","Photography","Pioneering",
  "Plant Science","Plumbing","Pottery","Programming","Public Health","Public Speaking",
  "Pulp and Paper","Radio","Railroading","Reading","Reptile and Amphibian Study",
  "Rifle Shooting","Robotics","Rowing","Safety","Salesmanship","Scholarship",
  "Scouting Heritage","Scuba Diving","Sculpture","Search and Rescue","Shotgun Shooting",
  "Signs, Signals, and Codes","Skating","Small-Boat Sailing","Snow Sports",
  "Soil and Water Conservation","Space Exploration","Sports","Stamp Collecting",
  "Surveying","Sustainability","Swimming","Textile","Theater","Traffic Safety",
  "Truck Transportation","Veterinary Medicine","Water Sports","Weather","Welding",
  "Whitewater","Wilderness Survival","Wildland Fire Management","Wood Carving","Woodwork",
];

// The 13 required Eagle categories, expanded to all 17 badge names since
// three of those categories let a Scout choose between alternatives
// (Emergency Preparedness/Lifesaving, Environmental Science/Sustainability,
// Hiking/Cycling/Swimming). Kept independent of any troop's TWH export for
// the same reason as OFFICIAL_BADGES - a badge nobody has ever earned won't
// appear in the data at all, asterisk or not, so there's no way to detect
// "this is Eagle-required" from the export alone.
// NOTE: Citizenship in Society was discontinued as an Eagle-required badge
// effective Feb. 27, 2026 (Eagle dropped from 14 to 13 required badges,
// electives went from 7 to 8; total stays 21). It remains a valid elective
// and stays in OFFICIAL_BADGES above.
const EAGLE_REQUIRED_BADGES = [
  "Camping", "Citizenship in the Community",
  "Citizenship in the Nation", "Citizenship in the World", "Communication",
  "Cooking", "Cycling", "Emergency Preparedness", "Environmental Science",
  "Family Life", "First Aid", "Hiking", "Lifesaving", "Personal Fitness",
  "Personal Management", "Sustainability", "Swimming",
];

module.exports = { OFFICIAL_BADGES, EAGLE_REQUIRED_BADGES };
