const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { verifyToken, requireAdmin } = require('../middleware/auth');

// Register or get user profile (called after Firebase login)
router.post('/sync', verifyToken, async (req, res) => {
  try {
    const { name, email, uid } = req.user;
    
    let user = await User.findOne({ email: email.toLowerCase() });
    
    if (!user) {
      // Check if this is the very first user in the system to allow Admin setup
      const count = await User.countDocuments();
      if (count === 0) {
        user = new User({
          uid,
          name: name || email.split('@')[0],
          email: email.toLowerCase(),
          role: 'Admin',
          assignedDevices: ['RICE_MILL_001']
        });
        await user.save();
      } else {
        // Automatically register as a Guest user
        user = new User({
          uid,
          name: name || email.split('@')[0],
          email: email.toLowerCase(),
          role: 'Guest',
          assignedDevices: []
        });
        await user.save();
        console.log(`👤 New Guest user registered: ${email}`);
      }
    } else {
      // Update UID if it was pre-registered by email
      if (user.uid === user.email) {
        user.uid = uid;
        await user.save();
      }
    }
    
    res.json({ ...user.toObject(), isRegistered: true });
  } catch (err) {
    console.error('Error syncing user:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Register a new user
router.post('/register', async (req, res) => {
  try {
    const { name, phone, email, deviceId, millName } = req.body;
    let normalizedEmail = email.toLowerCase();
    
    let user = await User.findOne({ email: normalizedEmail });
    if (user) {
      user.name = name;
      user.phone = phone;
      user.role = 'User'; // Upgrade Guest to User if Admin registers them
      if (millName) user.millName = millName;
      if (deviceId && !user.assignedDevices.includes(deviceId)) {
        user.assignedDevices.push(deviceId);
      }
    } else {
      user = new User({
        uid: normalizedEmail, // Temporary UID
        name,
        phone,
        email: normalizedEmail,
        role: 'User',
        millName: millName || 'Rice Mill',
        assignedDevices: deviceId ? [deviceId] : []
      });
    }
    await user.save();
    res.status(201).json({ message: 'User registered successfully', user });
  } catch (error) {
    res.status(500).json({ message: 'Error registering user' });
  }
});

// Admin Route: Get all users
router.get('/', async (req, res) => {
  try {
    const users = await User.find();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Add device to user
router.post('/:email/devices', async (req, res) => {
  try {
    const { email } = req.params;
    const { deviceId } = req.body;
    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (!user.assignedDevices.includes(deviceId)) {
      user.assignedDevices.push(deviceId);
      await user.save();
    }
    res.json({ message: 'Device added successfully', user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Remove device from user
router.delete('/:email/devices/:deviceId', async (req, res) => {
  try {
    const { email, deviceId } = req.params;
    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.assignedDevices = user.assignedDevices.filter(id => id !== deviceId);
    await user.save();
    res.json({ message: 'Device removed successfully', user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Admin share access
router.post('/:email/share', async (req, res) => {
  try {
    const { email } = req.params;
    const { sharedEmail } = req.body;
    let owner = await User.findOne({ email: email.toLowerCase() });
    if (!owner) return res.status(404).json({ message: 'Owner user not found' });

    let sharedUser = await User.findOne({ email: sharedEmail.toLowerCase() });
    if (sharedUser) {
      owner.assignedDevices.forEach(d => {
        if (!sharedUser.assignedDevices.includes(d)) sharedUser.assignedDevices.push(d);
      });
      sharedUser.isSharedUser = true;
      sharedUser.mainUserEmail = owner.email;
      await sharedUser.save();
    } else {
      sharedUser = new User({
        uid: sharedEmail.toLowerCase(),
        name: 'Shared User',
        email: sharedEmail.toLowerCase(),
        assignedDevices: [...owner.assignedDevices],
        isSharedUser: true,
        mainUserEmail: owner.email
      });
      await sharedUser.save();
    }

    if (!owner.sharedWith.includes(sharedEmail.toLowerCase())) {
      owner.sharedWith.push(sharedEmail.toLowerCase());
      await owner.save();
    }
    res.json({ message: 'Access shared successfully', sharedUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Revoke shared access
router.delete('/:email/share/:sharedEmail', async (req, res) => {
  try {
    const { email, sharedEmail } = req.params;
    let owner = await User.findOne({ email: email.toLowerCase() });
    if (!owner) return res.status(404).json({ message: 'Owner user not found' });

    let sharedUser = await User.findOne({ email: sharedEmail.toLowerCase() });
    if (sharedUser) {
      // Remove owner's devices from shared user
      sharedUser.assignedDevices = sharedUser.assignedDevices.filter(d => !owner.assignedDevices.includes(d));
      
      // If they have no more devices, they might not need to be a shared user anymore
      // or we can just update the status if this was their main source of access
      if (sharedUser.mainUserEmail === owner.email) {
        sharedUser.isSharedUser = false;
        sharedUser.mainUserEmail = null;
      }
      await sharedUser.save();
    }

    // Remove from owner's sharedWith list
    owner.sharedWith = owner.sharedWith.filter(e => e !== sharedEmail.toLowerCase());
    await owner.save();

    res.json({ message: 'Access revoked successfully', owner });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Delete user
router.delete('/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const user = await User.findOneAndDelete({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Also clean up references in other users' sharedWith lists
    await User.updateMany(
      { sharedWith: email.toLowerCase() },
      { $pull: { sharedWith: email.toLowerCase() } }
    );

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Route: Update user profile
router.put('/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const { name, phone, newEmail, millName, role } = req.body;
    
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (millName) user.millName = millName;
    if (role) user.role = role;
    
    if (newEmail && newEmail.toLowerCase() !== user.email) {
      const normalizedNewEmail = newEmail.toLowerCase();
      // Check if new email is already taken
      const existing = await User.findOne({ email: normalizedNewEmail });
      if (existing) return res.status(400).json({ message: 'New email is already in use' });
      
      const oldEmail = user.email;
      user.email = normalizedNewEmail;

      // Update references in sharedWith lists
      await User.updateMany(
        { sharedWith: oldEmail },
        { $set: { "sharedWith.$": normalizedNewEmail } }
      );
    }

    await user.save();
    res.json({ message: 'User updated successfully', user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Share device access with another email
router.post('/share', verifyToken, async (req, res) => {
  try {
    const { emailToShare, deviceIds } = req.body;
    const owner = await User.findOne({ uid: req.user.uid });
    
    if (!owner) return res.status(404).json({ error: 'Owner not found' });
    if (!owner.assignedDevices || owner.assignedDevices.length === 0) {
      return res.status(400).json({ error: 'No devices to share' });
    }

    // Use provided deviceIds or default to all if not specified (backward compatibility)
    const devicesToShare = deviceIds && deviceIds.length > 0 
      ? deviceIds 
      : owner.assignedDevices;

    // Validate that the owner actually owns these devices
    const unauthorized = devicesToShare.filter(d => !owner.assignedDevices.includes(d));
    if (unauthorized.length > 0) {
      return res.status(403).json({ error: 'You do not have access to some of these devices' });
    }

    // Create invitation instead of immediate assignment
    const invitation = {
      ownerEmail: owner.email,
      ownerName: owner.name,
      millName: owner.millName,
      devices: devicesToShare
    };

    let recipient = await User.findOne({ email: emailToShare.toLowerCase() });
    if (recipient) {
      recipient.pendingInvitations.push(invitation);
      await recipient.save();
    } else {
      // Create a placeholder user so they get the invite on first login
      recipient = new User({
        uid: emailToShare.toLowerCase(),
        name: emailToShare.split('@')[0],
        email: emailToShare.toLowerCase(),
        role: 'Guest',
        pendingInvitations: [invitation]
      });
      await recipient.save();
    }

    if (!owner.sharedWith.includes(emailToShare.toLowerCase())) {
      owner.sharedWith.push(emailToShare.toLowerCase());
      await owner.save();
    }
    res.json({ message: 'Invitation sent successfully', status: 'pending' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept Invitation
router.post('/invitations/accept', verifyToken, async (req, res) => {
  try {
    const { ownerEmail } = req.body;
    const user = await User.findOne({ uid: req.user.uid });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const invite = user.pendingInvitations.find(i => i.ownerEmail === ownerEmail);
    if (!invite) return res.status(404).json({ error: 'Invitation not found' });

    // Add devices
    for (const deviceId of invite.devices) {
      if (!user.assignedDevices.includes(deviceId)) {
        user.assignedDevices.push(deviceId);
      }
    }

    // Upgrade Role and set relations
    user.isSharedUser = true;
    user.mainUserEmail = invite.ownerEmail;
    if (user.role === 'Guest') {
      user.role = 'User';
      user.millName = invite.millName;
    }

    // Remove invite
    user.pendingInvitations = user.pendingInvitations.filter(i => i.ownerEmail !== ownerEmail);
    
    await user.save();
    res.json({ message: 'Invitation accepted', user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Decline Invitation
router.post('/invitations/decline', verifyToken, async (req, res) => {
  try {
    const { ownerEmail } = req.body;
    const user = await User.findOne({ uid: req.user.uid });
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.pendingInvitations = user.pendingInvitations.filter(i => i.ownerEmail !== ownerEmail);
    await user.save();
    res.json({ message: 'Invitation declined' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get shared users details for owner
router.get('/:email/shared-details', verifyToken, async (req, res) => {
  try {
    const { email } = req.params;
    const owner = await User.findOne({ email: email.toLowerCase() });
    if (!owner) return res.status(404).json({ message: 'Owner not found' });

    const sharedUsers = await User.find({ email: { $in: owner.sharedWith } });
    
    const details = sharedUsers.map(u => ({
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.mainUserEmail === owner.email ? 'Accepted' : 'Pending'
    }));

    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Guest Route: Add device by ID
router.post('/add-guest-device', verifyToken, async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Device ID is required' });

    const user = await User.findOne({ uid: req.user.uid });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.role !== 'Guest') {
      return res.status(403).json({ error: 'Only Guest users can manually add devices' });
    }

    if (!user.assignedDevices.includes(deviceId)) {
      user.assignedDevices.push(deviceId);
      await user.save();
    }

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Guest Route: Remove device by ID
router.delete('/remove-guest-device/:deviceId', verifyToken, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const user = await User.findOne({ uid: req.user.uid });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.role !== 'Guest') {
      return res.status(403).json({ error: 'Only Guest users can manually remove devices' });
    }

    user.assignedDevices = user.assignedDevices.filter(id => id !== deviceId);
    await user.save();

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
